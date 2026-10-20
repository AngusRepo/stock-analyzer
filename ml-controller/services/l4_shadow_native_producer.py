"""Frozen native predictions and recommendation capture -> private daily source.

This consumer never dispatches inference or calls node_recommend. Each entry
must supply its own completed chain and complete recommendation capture. A
projection, current config, or another entry's prediction cannot fill a gap.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from services.l4_challenger_comparison import digest, seal
from services.l4_shadow_input_export import publish_day, source_from_packet
from services.l4_shadow_producer import read_reference


def validate_prediction_state(state, identity):
    """Verify the archived full predictions against their own eight-model chain."""
    from services.alpha_model_roster import validate_order
    from services.ensemble_v2 import ensemble_artifact_id, validate_active8_ensemble_candidate
    from services.frozen_manifest_budget import canonical_manifest_bytes
    from services.l4_distribution_runtime import native_features
    from services.recommendation_service import calculate_ml_score, _rescale_score

    context = state.get('pipeline_modal_serving_context') or {}
    manifest = context.get('serving_manifest') or {}
    parent = manifest.get('active8_ensemble') or {}
    models = manifest.get('models') or []
    try:
        validate_active8_ensemble_candidate(parent)
    except (RuntimeError, ValueError, TypeError) as exc:
        raise ValueError('shadow_native_parent_artifact_invalid') from exc
    if (context.get('schema_version') != 'pipeline-modal-serving-context-v1'
            or hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()
            != context.get('serving_manifest_digest')
            or ensemble_artifact_id(parent) != identity.get('artifact_id')
            or any(parent.get(k) != identity.get(k) for k in
                   ('payload_checksum', 'cohort_id', 'base_artifact_set_checksum'))
            or digest(parent.get('base_artifacts')) != identity.get('base_artifact_set_checksum')
            or digest(parent.get('observation_artifacts')) != parent.get('observation_artifact_set_checksum')
            or any(parent['base_artifacts'][name] != parent['observation_artifacts'][name]
                   for name in parent['selected_models'])):
        raise ValueError('shadow_native_frozen_chain_mismatch')
    order = validate_order(parent['model_order'])
    if len(order) != 8 or len(models) != len(order) or {r['model'] for r in models} != set(order):
        raise ValueError('shadow_native_eight_model_inventory_missing')
    for row in models:
        frozen = parent['observation_artifacts'].get(row['model']) or {}
        if any(row.get(k) != frozen.get(k) for k in ('artifact_id', 'version', 'checksum')):
            raise ValueError('shadow_native_base_artifact_mismatch')
    predictions = state.get('predictions')
    payloads = state.get('payloads')
    if (not isinstance(predictions, dict) or not predictions or not isinstance(payloads, list)
            or not payloads or {p['symbol'] for p in payloads} != set(predictions)
            or len(payloads) != len(predictions)):
        raise ValueError('shadow_native_raw_predictions_required')
    for prediction in predictions.values():
        if prediction.get('error') or prediction.get('ensemble_v2', {}).get('model_order') != list(order):
            raise ValueError('shadow_native_prediction_failed')
        edge = _rescale_score(calculate_ml_score(prediction['ensemble_v2'], prediction), 30, 25)
        native_features({'score_components': {'components': {'mlEdge': edge}}}, prediction, identity)


async def collect_completed_prediction_state(*, bucket, observation, identity, day):
    """Read a completed native observation and re-merge its original raw bundle.

    Uses the same validators/merger as collect(), without prepare(), advance(),
    Modal, polling, or any write. The original feature projection is only a
    readback check; it is never passed off as raw predictions.
    """
    from services import l4_native_observation as native
    from graphs import daily_pipeline_v2 as pipeline

    read = lambda ref: native.read_reference(bucket, ref)
    config = observation['config']
    if config['l3_identity'] != identity:
        raise ValueError('shadow_native_observation_chain_mismatch')
    context = read(config['serving_context'])
    cutoffs = read(config['training_cutoffs'])
    records = {r['model']: read(r['reference']) for r in cutoffs.get('source_references', [])}
    known = native.validate_context(context, identity, cutoffs, day, records)
    snapshot = read(observation['projection'])
    original_ref = snapshot['original_reference']
    original = read(original_ref)
    envelope = read(observation['envelope'])
    projected = {k: v for k, v in snapshot.items() if k not in
                 ('snapshot_id', 'original_reference', 'original_sha256',
                  'verified_original_sha256', 'frozen_at')}
    if (snapshot.get('signal_date') != day or original.get('scope') != native.SCOPE
            or original.get('projection') != projected
            or snapshot.get('original_sha256') != original_ref['sha256']
            or snapshot.get('verified_original_sha256') != original_ref['sha256']
            or original.get('training_cutoffs') != config['training_cutoffs']
            or original.get('request') != envelope.get('request')
            or original.get('classification') != envelope.get('catalog_reference')
            or original.get('risk_reference') != envelope.get('risk_reference')
            or original.get('roster_checksum') != digest(envelope.get('roster'))
            or original.get('roster_proof') != envelope.get('roster_proof')):
        raise ValueError('shadow_native_original_binding_invalid')
    request = read(original['request'])
    bundle = read(original['raw_bundle_reference'])
    if bundle.get('execution_scope') != native.SCOPE:
        raise ValueError('shadow_native_output_scope_invalid')
    context = deepcopy(context)
    context['expected_source_sha'] = request['expected_source_sha']
    state = dict(run_date=day, producer_run_id=request['run_id'], payloads=request['payloads'],
                 pipeline_modal_serving_context=context,
                 pipeline_modal_sequence_input_contract=request['sequence_input_contract'],
                 modal_prediction_bundle=bundle)
    pipeline._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)
    state.update(await pipeline.node_ml_predict(state, research_only=True))
    if native.projection(state['predictions'], identity=identity, day=day,
                         roster=envelope['roster'], classification=envelope['classification'],
                         known_max=known) != original['projection']:
        raise ValueError('shadow_native_original_projection_changed')
    validate_prediction_state(state, identity)
    return state


def build_source(*, entry, state, recommendation_context, day_inputs, observed_at, now):
    """Run the captured recommendation path, then serialize its private packet."""
    from services.l4_private_execution import frozen_legacy_loader, frozen_p6_loader
    from services.l4_tabpack_weights import private_weight_reader
    from services.paired_nav_recommendation_path import replay_recommendation_context

    day = day_inputs['signal_date']
    inputs = deepcopy(day_inputs['l4_allocation_inputs'])
    policy = inputs['alpha_policy']['l4Distribution']
    identity = policy['artifact']['l3_identity']
    if (state.get('run_date') != day or identity['payload_checksum'] != entry['components']['L3']
            or policy['artifact']['model_checksum'] != entry['components']['L4']):
        raise ValueError('shadow_native_entry_chain_mismatch')
    validate_prediction_state(state, identity)
    captured = recommendation_context.get('inputs') or {}
    options = captured.get('filter_options') or {}
    required_options = {'persona_opinions', 'persona_weight', 'regime_label', 'regime_surface',
                        'alpha_policy', 'fundamental_quality_by_symbol',
                        'pit_sector_alpha_by_symbol', 'run_date'}
    if (not {'screener_recs', 'predictions', 'payloads', 'filter_options'} <= set(captured)
            or not required_options <= set(options)):
        raise ValueError('shadow_native_recommendation_context_incomplete')
    if (options['run_date'] != day or digest(captured['predictions']) != digest(state['predictions'])
            or digest(captured['payloads']) != digest(state['payloads'])
            or options['alpha_policy'].get('l4Distribution', {}).get('artifact') != policy['artifact']):
        raise ValueError('shadow_native_recommendation_source_mismatch')
    filter_policy = deepcopy(options['alpha_policy'])
    allocation_policy = deepcopy(inputs['alpha_policy'])
    for value in (filter_policy, allocation_policy):
        value['l4Distribution'].pop('runtime', None)
    if filter_policy != allocation_policy or any(
            key in inputs and inputs[key] != options[source]
            for key, source in (('regime_label', 'regime_label'), ('surface', 'regime_surface'))):
        raise ValueError('shadow_native_recommendation_policy_mismatch')
    # Every private execution uses pinned bytes; integrity checks are unchanged.
    frozen_p6_loader(inputs, policy['artifact'])
    with private_weight_reader(frozen_legacy_loader(inputs, policy['artifact'])):
        result = replay_recommendation_context(recommendation_context)
    runtime = deepcopy(policy.get('runtime') or {})
    # The private account/OPB owner supplies these at frame execution.
    runtime.pop('account', None)
    inputs.pop('opb_reward_ledger', None)
    runtime.update(signal_date=day, l3_identity=identity,
                   predictions=deepcopy(recommendation_context['post_predictions']))
    policy['runtime'] = runtime
    inputs['recommendations'] = result['recommendations']
    packet = deepcopy(day_inputs)
    packet.update(recommendations=result['recommendations'], l4_allocation_inputs=inputs,
                  serving_identity=deepcopy(entry['serving_identity']))
    packet['trading_config']['l4Distribution'] = deepcopy(policy)
    packet.pop('checksum', None)
    return source_from_packet(seal(packet), entry, observed_at=observed_at, now=now)


async def produce_directory(registry, directory, *, session_date, now):
    """Cloud Job entry: original capture references per registry entry.

    <entry_id>.json contains entry_checksum, day_inputs_reference,
    recommendation_context_reference, observed_at, and exactly one of
    state_reference / completed_observation. References retain their existing
    owners' schemas. All entries are ready before publish_day writes anything.
    """
    current, _ = registry.current()
    root = Path(directory)
    if not current or not current.get('entries') or not root.is_dir():
        raise ValueError('shadow_native_producer_inventory_invalid')
    files = {p.stem: p for p in root.glob('*.json') if p.is_file()}
    if set(files) != set(current['entries']):
        raise ValueError('shadow_native_producer_inventory_invalid')
    sources, failures = {}, {}
    for key, entry in current['entries'].items():
        try:
            spec = json.loads(files[key].read_bytes())
            if (spec.get('entry_checksum') != entry['checksum']
                    or ('state_reference' in spec) == ('completed_observation' in spec)):
                raise ValueError('shadow_native_producer_binding_invalid')
            day_inputs = read_reference(registry.bucket, spec['day_inputs_reference'])
            context = read_reference(registry.bucket, spec['recommendation_context_reference'])
            if day_inputs.get('session_date') != session_date:
                raise ValueError('shadow_native_producer_session_mismatch')
            receipts = list(day_inputs.get('source_receipt_shas') or [])
            receipts.extend(spec[k]['sha256'] for k in
                            ('day_inputs_reference', 'recommendation_context_reference'))
            if 'state_reference' in spec:
                state = read_reference(registry.bucket, spec['state_reference'])
                receipts.append(spec['state_reference']['sha256'])
            else:
                observation = spec['completed_observation']
                state = await collect_completed_prediction_state(bucket=registry.bucket,
                    observation=observation,
                    identity=day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']['artifact']['l3_identity'],
                    day=day_inputs['signal_date'])
                receipts.extend(observation[k]['sha256'] for k in ('projection', 'envelope'))
            day_inputs['source_receipt_shas'] = sorted(set(receipts))
            sources[key] = build_source(entry=entry, state=state, recommendation_context=context,
                day_inputs=day_inputs, observed_at=spec['observed_at'], now=now)
        except (ValueError, KeyError, TypeError) as exc:
            # Do not expose arbitrary provider text in a source readiness report.
            code = str(exc)
            failures[key] = code if code.startswith(('shadow_', 'private_', 'l4_', 'paired_nav_')) and code.replace('_', '').isalnum() else 'shadow_native_source_invalid'
    if failures:
        return dict(status='not_ready', session_date=session_date, entries=failures,
                    production_effect=False, outer_acceptance_credit=0)
    latest, _ = registry.current()
    if latest != current:
        raise ValueError('shadow_native_producer_registry_changed')
    return publish_day(registry, sources, session_date=session_date, now=now)
