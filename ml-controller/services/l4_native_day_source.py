"""Prepare native inference from explicit frozen facts, without live fallback."""
from copy import deepcopy
from datetime import date, datetime, timezone
import os
import re

from services.l4_forward_materialization import digest, timestamp
from services.l4_shadow_producer import read_reference

SCHEMA = 'l4-native-frozen-day-source-v1'
STATE_FIELDS = ('market_env', 'adaptive_params', 'barrier_params', 'lifecycle_weights',
                'trading_config', 'payload_source_observations', 'timexer_feature_source')


def source_clock(bucket, reference):
    """Server creation time is evidence of availability, never a label date."""
    blob = bucket.blob(reference['path'])
    blob.reload()
    created = getattr(blob, 'time_created', None)
    if created is None:
        raise ValueError('l4_native_frozen_source_server_clock_missing')
    created = created.isoformat() if isinstance(created, datetime) else created
    return dict(path=reference['path'], sha256=reference['sha256'],
                generation=str(blob.generation), created_at=timestamp(created).isoformat())


def load_day_source(bucket, reference, *, day, now=None):
    return validate_day_source(bucket, read_reference(bucket, reference),
                               day=day, now=now, source_reference=reference)


def validate_day_source(bucket, source, *, day, now=None, source_reference=None):
    """Read original facts and validate their existing owners' contracts."""
    from services.l4_native_observation import read_reference as native_read
    from services.l4_instrument_classification import select
    from services.payload_builder import _read_frozen_payload_sources
    from services.paired_nav_journal import digest as source_digest
    from services.l4_distribution import digest as risk_digest

    clock = now or datetime.now(timezone.utc)
    if (source.get('schema_version') != SCHEMA or source.get('signal_date') != day
            or not source.get('source_receipt_shas')
            or any(not re.fullmatch('[a-f0-9]{64}', str(v))
                   for v in source['source_receipt_shas'])
            or timestamp(source['observed_at']) > clock):
        raise ValueError('l4_native_frozen_day_source_invalid')
    date.fromisoformat(day)
    state = source['state']
    if any(not isinstance(state.get(k), dict) for k in STATE_FIELDS):
        raise ValueError('l4_native_frozen_day_state_incomplete')
    roster, proof = source['roster'], source['roster_proof']
    if (not isinstance(roster, list) or not 1 <= len(roster) <= 5000
            or proof.get('roster_checksum') != digest(roster)):
        raise ValueError('l4_native_frozen_roster_invalid')
    catalog = native_read(bucket, source['classification_reference'])
    if (catalog.get('schema_version') != 'l4-official-observed-listing-v1'
            or catalog.get('business_date') != day
            or timestamp(catalog['observed_at']) > timestamp(source['observed_at'])):
        raise ValueError('l4_native_frozen_listing_date')
    selected, classification, exclusions = select(roster, catalog, day)
    if not selected:
        raise ValueError('l4_native_frozen_roster_empty')
    packet = state['payload_source_observations']
    _read_frozen_payload_sources(packet, selected, day, copy_data=False)
    if timestamp(packet['observed_at']) > timestamp(source['observed_at']):
        raise ValueError('l4_native_frozen_payload_clock')
    feature = state['timexer_feature_source']
    binding = packet.get('single_capture_binding') or {}
    if (feature.get('status') != 'ready' or feature.get('signal_date') != day
            or binding.get('schema_version') != 'daily-single-capture-binding-v1'
            or binding.get('feature_source_digest') != source_digest(feature)):
        raise ValueError('l4_native_frozen_single_capture_missing')
    risk = native_read(bucket, source['risk_reference'])
    if (risk.get('schema_version') != 'l4-dated-risk-v1' or risk.get('signal_date') != day
            or risk.get('checksum') != risk_digest({k: v for k, v in risk.items() if k != 'checksum'})
            or {r['symbol'] for r in selected} - set(risk.get('returns') or {})):
        raise ValueError('l4_native_frozen_risk_invalid')
    refs = [source['classification_reference'], source['risk_reference']]
    if source_reference is not None:
        refs.append(source_reference)
    for ref in source.get('original_references', {}).values():
        refs.append(ref)
    clocks = [source_clock(bucket, ref) for ref in refs]
    known = max([timestamp(source['observed_at'])] +
                [timestamp(row['created_at']) for row in clocks])
    if known > clock:
        raise ValueError('l4_native_frozen_source_not_yet_known')
    return source, selected, classification, exclusions, dict(known_at=known.isoformat(), objects=clocks)


async def prepare_day_source(*, bucket, reference, config, context, day, now=None):
    """Pure request construction; all registry entries finish this before dispatch.

    Unlike node_build_payloads this does not prepare features, capture a new
    roster, load market settings, or publish slate checkpoints.
    """
    from services.payload_builder import MarketEnv, build_payloads, VerifiedPayloadSources
    from services.l4_native_l2_dependency import enrich
    from services.l4_native_observation import SCOPE
    from graphs import daily_pipeline_v2 as pipeline

    source, roster, classification, exclusions, knowledge = load_day_source(
        bucket, reference, day=day, now=now)
    code = os.environ.get('STOCKVISION_SOURCE_SHA', '')
    if not re.fullmatch('[a-f0-9]{40}', code):
        raise ValueError('l4_native_source_version_missing')
    key = digest(dict(day=day, identity=config['l3_identity'], policy=config))
    state = {k: deepcopy(source['state'][k]) for k in STATE_FIELDS}
    state.update(run_date=day, producer_run_id='l4-native:' + key, active_stocks=roster,
                 pipeline_modal_serving_context=deepcopy(context))
    state['pipeline_modal_serving_context']['expected_source_sha'] = code
    packet = state['payload_source_observations']
    market = MarketEnv(**state['market_env'])
    if 'global_market_history' in packet:
        market.history = packet['global_market_history']
    view = VerifiedPayloadSources(packet, day)
    state['payloads'] = [dict(vars(row)) for row in build_payloads(
        active_stocks=roster, market_env=market, adaptive_params=state['adaptive_params'],
        barrier_params=state['barrier_params'], lifecycle_weights=state['lifecycle_weights'],
        trading_config=state['trading_config'], decision_date=day,
        frozen_sources=packet, verified_sources=view)]
    # The raw source contains the complete pool. Never import another chain's
    # predictions, serving context, or stale sequence packet from the envelope.
    state.update(await enrich(state, pipeline=pipeline, bucket=bucket, config=config,
                              read_reference=read_reference))
    request = await pipeline._build_pipeline_modal_prediction_payload(
        state, state_gcs_uri='', research_only=True)
    request.update(execution_scope=SCOPE, max_symbols=5000)
    proof = deepcopy(source['roster_proof'])
    proof.update(official_listing=source['classification_reference'],
                 official_listing_exclusions=exclusions, inference_roster_checksum=digest(roster))
    prepared = dict(day=day, key=key, source_reference=reference,
        configuration_checksum=digest(config), context_checksum=digest(context),
        trading_config_checksum=digest(state['trading_config']), observed_at=knowledge['known_at'],
        declared_observed_at=source['observed_at'], source_availability=knowledge,
        source_checksum=packet['source_checksum'], source_code=code, request=request,
        envelope=dict(roster=roster, roster_proof=proof, classification=classification,
            catalog_reference=source['classification_reference'], risk_reference=source['risk_reference'],
            frozen_day_source_reference=reference))
    return {**prepared, 'checksum': digest(prepared)}


def validate_prepared(prepared, *, reference, config, context, day):
    if (prepared.get('checksum') != digest({k: v for k, v in prepared.items() if k != 'checksum'})
            or prepared.get('source_reference') != reference or prepared.get('day') != day
            or prepared.get('configuration_checksum') != digest(config)
            or prepared.get('context_checksum') != digest(context)
            or prepared.get('source_code') != os.environ.get('STOCKVISION_SOURCE_SHA')
            or prepared.get('key') != digest(dict(day=day, identity=config['l3_identity'], policy=config))):
        raise ValueError('l4_native_frozen_preparation_changed')


def validate_resume(bucket, *, config, day, source_reference, prepared=None):
    """A new source cannot silently inherit a prior request or completed index."""
    import json
    from services.l4_native_observation import PREFIX, read_reference as native_read

    key = digest(dict(day=day, identity=config['l3_identity'], policy=config))
    pointer = bucket.blob(PREFIX + 'requests/' + key + '.json')
    index_exists = bucket.blob(PREFIX + 'index/' + key + '.json').exists()
    if pointer.exists():
        envelope_ref = json.loads(pointer.download_as_bytes())
        envelope = native_read(bucket, envelope_ref)
        if envelope.get('frozen_day_source_reference') != source_reference:
            raise ValueError('l4_native_frozen_resume_source_changed')
        if prepared is not None and (
                envelope.get('frozen_preparation_checksum') != prepared['checksum']
                or native_read(bucket, envelope['request']) != prepared['request']):
            raise ValueError('l4_native_frozen_resume_request_changed')
        if not index_exists:
            dispatch = PREFIX + 'dispatch/' + key + '/'
            receipt = bucket.blob(dispatch + 'receipt.json')
            if bucket.blob(dispatch + 'claim.json').exists() and not receipt.exists():
                raise ValueError('l4_native_dispatch_acknowledgement_missing')
            if receipt.exists():
                saved = json.loads(receipt.download_as_bytes())
                request = native_read(bucket, envelope['request'])
                if saved.get('envelope') != envelope_ref or saved.get('request_checksum') != digest(request):
                    raise ValueError('l4_native_dispatch_input_changed')
        return True
    elif index_exists:
        raise ValueError('l4_native_frozen_resume_request_missing')
    elif bucket.blob(PREFIX + 'claims/' + key + '.json').exists():
        raise ValueError('l4_native_existing_dispatch_requires_recovery')
    return False


def publish_prepared(bucket, *, prepared):
    """Use the existing native claim and envelope paths; never replace a claim."""
    import json
    from google.api_core.exceptions import PreconditionFailed
    from services.l4_native_observation import PREFIX
    from services.l4_forward_refresh import publish

    key = prepared['key']
    claim = bucket.blob(PREFIX + 'claims/' + key + '.json')
    try:
        claim.upload_from_string(json.dumps(dict(day=prepared['day'],
            configuration_checksum=prepared['configuration_checksum'],
            source_checksum=prepared['source_checksum'],
            frozen_day_source_reference=prepared['source_reference'])), if_generation_match=0)
    except PreconditionFailed as exc:
        raise ValueError('l4_native_existing_dispatch_requires_recovery') from exc
    request_ref = publish(bucket, 'native_requests', prepared['request'])
    envelope = publish(bucket, 'native_envelopes', dict(prepared['envelope'], request=request_ref,
        frozen_preparation_checksum=prepared['checksum']))
    bucket.blob(PREFIX + 'requests/' + key + '.json').upload_from_string(
        json.dumps(envelope), if_generation_match=0)
    return envelope
