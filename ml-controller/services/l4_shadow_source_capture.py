"""Package explicit original pipeline facts for registered frozen chains.

Reads the original compressed state through its existing codec. This performs
no new market capture, feature prep, prediction, or live configuration lookup.
"""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json

from services.l4_native_day_source import (
    SCHEMA, STATE_FIELDS, source_clock, validate_day_source)
from services.l4_shadow_producer import read_reference
from services.l4_shadow_input_export import _put
from services.l4_forward_materialization import timestamp, digest

PREFIX = 'l4_distribution/shadow_observation_sources/v1/'


def read_original_state(bucket, reference):
    from services.pipeline_async_state_transport import decode_pipeline_state_envelope
    if (not isinstance(reference, dict) or not reference.get('path')
            or not str(reference.get('generation', '')).isdigit()
            or len(reference.get('sha256', '')) != 64):
        raise ValueError('shadow_source_reference_invalid')
    blob = bucket.blob(reference['path'])
    blob.reload()
    if str(blob.generation) != str(reference['generation']):
        raise ValueError('shadow_source_generation_changed')
    raw = blob.download_as_bytes(if_generation_match=blob.generation)
    if hashlib.sha256(raw).hexdigest() != reference['sha256']:
        raise ValueError('shadow_source_bytes_changed')
    original = decode_pipeline_state_envelope(raw)
    state = original['state']
    return original, state


def package_source(bucket, spec, day_inputs, *, now):
    """Build an envelope from actual original refs, preserving original clocks."""
    reference = spec['captured_state_reference']
    original, state = read_original_state(bucket, reference)
    day = day_inputs['signal_date']
    if state.get('run_date') != day or original.get('run_date') != day:
        raise ValueError('shadow_observation_original_state_day')
    roster_ref = spec['roster_reference']
    roster = read_reference(bucket, roster_ref)
    refs = dict(captured_state=reference, roster=roster_ref,
                classification=spec['classification_reference'], risk=spec['risk_reference'])
    clocks = [source_clock(bucket, r) for r in refs.values()]
    observed = max([timestamp(state['payload_source_observations']['observed_at'])] +
                   [timestamp(row['created_at']) for row in clocks])
    if observed > now:
        raise ValueError('shadow_observation_original_source_not_yet_known')
    # Preserve upstream facts/policy verbatim. L4 calibration is downstream of
    # the shared native observation; its entry-specific policy lives in the
    # separately bound day-input spec, not this source identity.
    facts = {key: deepcopy(state[key]) for key in STATE_FIELDS}
    source = dict(schema_version=SCHEMA, signal_date=day, observed_at=observed.isoformat(),
        source_receipt_shas=sorted({r['sha256'] for r in refs.values()}),
        original_references=refs, original_producer_run_id=state.get('producer_run_id'),
        original_created_at=original.get('created_at'), roster=deepcopy(roster['roster']),
        roster_proof=deepcopy(roster['roster_proof']),
        classification_reference=spec['classification_reference'],
        risk_reference=spec['risk_reference'], state=facts)
    validate_day_source(bucket, source, day=day, now=now)
    return source


def capture_directory(registry, directory, *, session_date, now, clock=None):
    """Validate every input, package immutable sources, then write their index."""
    from services.l4_shadow_observation import _reason

    clock = clock or (lambda: datetime.now(timezone.utc))
    current, _ = registry.current()
    root = Path(directory)
    files = {p.stem: p for p in root.glob('*.json') if p.is_file()}
    if not current or not current.get('entries') or set(files) != set(current['entries']):
        raise ValueError('shadow_observation_inventory_invalid')
    plans, failures = {}, {}
    for key, entry in current['entries'].items():
        try:
            spec = json.loads(files[key].read_bytes())
            if spec.get('entry_checksum') != entry['checksum']:
                raise ValueError('shadow_observation_entry_binding')
            day = read_reference(registry.bucket, spec['day_inputs_reference'])
            if day.get('session_date') != session_date:
                raise ValueError('shadow_observation_day_or_clock')
            source = package_source(registry.bucket, spec, day, now=now)
            plans[key] = (spec, source)
        except (ValueError, KeyError, TypeError) as exc:
            failures[key] = _reason(exc)
    if failures:
        return dict(status='not_ready', session_date=session_date, entries=failures,
                    production_effect=False, outer_acceptance_credit=0)
    if registry.current()[0] != current:
        raise ValueError('shadow_observation_registry_changed')
    entries = {}
    for key, (spec, source) in plans.items():
        ref = _put(registry.bucket, PREFIX + 'sources/' + digest(source) + '.json', source)
        _, _, _, _, knowledge = validate_day_source(registry.bucket, source,
            day=source['signal_date'], now=clock(), source_reference=ref)
        entries[key] = dict(entry_checksum=current['entries'][key]['checksum'],
            spec_checksum=digest(spec), frozen_day_source_reference=ref,
            observed_at=knowledge['known_at'])
    if registry.current()[0] != current:
        raise ValueError('shadow_observation_registry_changed')
    value = dict(schema_version='l4-shadow-observation-source-index-v1',
        registry_checksum=current['checksum'], session_date=session_date, entries=entries,
        production_effect=False, outer_acceptance_credit=0)
    ref = _put(registry.bucket, PREFIX + 'indexes/' + session_date + '/' +
               current['checksum'] + '.json', value)
    return dict(status='sources_captured', source_index_reference=ref,
                production_effect=False, outer_acceptance_credit=0)


def apply_source_index(bucket, reference, *, current, session_date, specs):
    index = read_reference(bucket, reference)
    if (index.get('schema_version') != 'l4-shadow-observation-source-index-v1'
            or index.get('registry_checksum') != current['checksum']
            or index.get('session_date') != session_date
            or set(index.get('entries', {})) != set(current['entries'])):
        raise ValueError('shadow_observation_source_index_invalid')
    result = {}
    for key, spec in specs.items():
        row = index['entries'][key]
        if (row['entry_checksum'] != current['entries'][key]['checksum']
                or row['spec_checksum'] != digest(spec)
                or 'frozen_day_source_reference' in spec):
            raise ValueError('shadow_observation_source_index_binding')
        result[key] = {**spec, 'frozen_day_source_reference': row['frozen_day_source_reference'],
                       'observed_at': row['observed_at']}
    return result
