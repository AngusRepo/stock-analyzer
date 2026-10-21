"""Sequence preparation identity. Legacy packets are read without changing evidence."""
from datetime import datetime, timezone
from services.paired_nav_journal import digest


def sequence_context(state):
    current = state.get('pipeline_sequence_context')
    # Read-only compatibility for original archived Atomic envelopes. This is
    # provenance validation, never permission to generate or consume forecasts.
    legacy = current is None
    value = state.get('pipeline_timesfm_context') if legacy else current
    schema = 'pipeline-timesfm-context-v1' if legacy else 'pipeline-sequence-context-v1'
    if (not isinstance(value, dict) or value.get('schema_version') != schema
            or value.get('signal_date') != state['run_date']
            or value.get('source_checksum') != digest({k:v for k,v in value.items() if k != 'source_checksum'})):
        raise ValueError('pipeline_sequence_context_invalid')
    if not legacy and value.get('sequence_checksum') != (state.get('pipeline_sequence_observations') or {}).get('source_checksum'):
        raise ValueError('pipeline_sequence_context_source_changed')
    return value


def capture_sequence_context(state):
    if state.get('pipeline_sequence_context') is not None:
        return sequence_context(state)
    sequence = state['pipeline_sequence_observations']
    if (sequence.get('schema_version') != 'pipeline-sequence-observations-v1'
            or sequence.get('signal_date') != state['run_date']
            or sequence.get('source_checksum') != digest({k:v for k,v in sequence.items() if k != 'source_checksum'})):
        raise ValueError('pipeline_sequence_observations_invalid')
    body = dict(schema_version='pipeline-sequence-context-v1', signal_date=state['run_date'],
        sequence_checksum=sequence['source_checksum'], observed_at=datetime.now(timezone.utc).isoformat())
    return {**body, 'source_checksum':digest(body)}
