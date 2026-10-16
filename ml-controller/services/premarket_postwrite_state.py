"""Bounded research-only projection of an immutable, full-history L3 seal.

Serving continues to consume the original state. Research checkpoints reference
that seal; they are never valid serving envelopes or replacement history sources.
"""
from __future__ import annotations

import gzip
import hashlib
import logging
import time
from decimal import Decimal

import ijson

from services.pipeline_async_state_transport import (
    STATE_SCHEMA_V1, STATE_SCHEMA_V2, STATE_SCHEMA_V3, build_pipeline_payload_identity,
)
from services.pipeline_json_transport import compress_json

POSTWRITE_SCHEMA = 'premarket-postwrite-state-v1'
PROJECTION_LIMIT = 4 * 1024 * 1024
CHUNK_SIZE = 4 * 1024 * 1024
STATE_FIELDS = {
    'run_date', 'producer_run_id', 'premarket_baseline',
    'snapshot_recovery_lineage', 'pipeline_payload_identity',
    'premarket_context', 'premarket_information', 'errors',
    'sector_flow_summary', 'pit_residual_shadow_summary',
}
HISTORY_FIELDS = {'payloads', 'l3_payloads', 'payload_source_observations'}


class _HashedReader:
    def __init__(self, source):
        self.source = source
        self.hash = hashlib.sha256()
        self.size = 0

    def read(self, size=-1):
        if size < 0:
            raise ValueError('premarket_postwrite_unbounded_read')
        raw = self.source.read(size)
        self.hash.update(raw)
        self.size += len(raw)
        return raw


def _projection(source):
    wanted = {'schema_version', 'source_receipt', 'context_checksum', 'phase'}
    wanted.update('state.' + key for key in STATE_FIELDS)
    result, rows = {}, {'payloads': [], 'l3_payloads': []}
    item_names = {'state.' + name + '.item': name for name in rows}
    symbol_fields = {item + '.' + field: (name, field)
                     for item, name in item_names.items() for field in ('symbol', 'stock_id')}
    current = {}
    selected, builder, depth, retained = None, None, 0, 0
    saw_state = False
    for prefix, event, value in ijson.parse(source, use_float=False):
        if prefix == 'state' and event == 'start_map':
            saw_state = True
        # Collect only symbol identity, never build a price/chip/indicator row.
        name = item_names.get(prefix)
        if name is not None:
            if event == 'start_map':
                current[name] = {}
            elif event == 'end_map':
                rows[name].append(current.pop(name))
            elif event != 'map_key':
                raise ValueError('pipeline_payload_identity_payloads_incomplete')
        field = symbol_fields.get(prefix)
        if field is not None:
            if event in ('start_map', 'start_array'):
                raise ValueError('pipeline_payload_identity_symbols_invalid')
            if event not in ('end_map', 'end_array', 'map_key'):
                current[field[0]][field[1]] = value
        if builder is None:
            # Our compact writer places schema_version first. Full legacy seals
            # are projected irrespective of their field ordering.
            compact_state = (result.get('schema_version') == POSTWRITE_SCHEMA and prefix == 'state')
            if (prefix not in wanted and not compact_state) or event in ('map_key', 'end_map', 'end_array'):
                continue
            selected, builder, depth = prefix, ijson.ObjectBuilder(), 0
        retained += len(value.encode('utf-8')) if isinstance(value, str) else 16
        if retained > PROJECTION_LIMIT:
            raise ValueError('premarket_postwrite_projection_too_large')
        if isinstance(value, Decimal):
            value = float(value)
        builder.event(event, value)
        depth += int(event in ('start_map', 'start_array')) - int(event in ('end_map', 'end_array'))
        if depth == 0:
            if selected.startswith('state.'):
                result.setdefault('state', {})[selected[6:]] = builder.value
            else:
                result[selected] = builder.value
            builder = None
    if not saw_state or not isinstance(result.get('state'), dict):
        raise ValueError('pipeline_async_state_missing')
    return result, rows


def read_postwrite_state(blob, receipt, *, phase=None, context_checksum=None,
                         payload_identity=None):
    """Verify all compressed bytes and gzip CRC before releasing a projection."""
    started = time.monotonic()
    blob.reload()  # Pin range requests to one generation, even on phase reads.
    with blob.open('rb', chunk_size=CHUNK_SIZE, if_generation_match=blob.generation) as raw:
        hashed = _HashedReader(raw)
        with gzip.GzipFile(fileobj=hashed, mode='rb') as source:
            envelope, rows = _projection(source)
    if phase is None and hashed.hash.hexdigest() != receipt['checksum']:
        raise ValueError('premarket_state_checksum')
    schema = envelope.get('schema_version')
    state = envelope['state']
    if schema in (STATE_SCHEMA_V1, STATE_SCHEMA_V2, STATE_SCHEMA_V3):
        identity = build_pipeline_payload_identity(rows['payloads'])
        contract = state.get('pipeline_payload_identity')
        if isinstance(contract, dict):
            if contract != identity:
                raise ValueError('pipeline_payload_identity_contract_mismatch')
        elif build_pipeline_payload_identity(rows['l3_payloads']) != identity:
            raise ValueError('pipeline_payload_identity_legacy_mismatch')
        state['pipeline_payload_identity'] = identity
    elif schema == POSTWRITE_SCHEMA and phase is not None:
        if (envelope.get('source_receipt') != receipt
                or envelope.get('context_checksum') != context_checksum
                or envelope.get('phase') != phase):
            raise ValueError('premarket_postwrite_checkpoint_identity_mismatch')
    else:
        raise ValueError('pipeline_async_state_schema_invalid')
    if HISTORY_FIELDS.intersection(state):
        raise ValueError('premarket_postwrite_checkpoint_history_forbidden')
    if (state.get('run_date') != receipt['run_date']
            or state.get('producer_run_id') != receipt['run_id']):
        raise ValueError('premarket_postwrite_run_mismatch')
    if payload_identity is not None and state.get('pipeline_payload_identity') != payload_identity:
        raise ValueError('pipeline_payload_identity_contract_mismatch')
    if phase is not None and (state.get('premarket_context') or {}).get('checksum') != context_checksum:
        raise ValueError('premarket_postwrite_context_mismatch')
    logging.getLogger(__name__).info(
        '[PremarketPostwriteState] phase=%s schema=%s compressed_bytes=%d seconds=%.3f payload_count=%s',
        phase or 'l3', schema, hashed.size, time.monotonic() - started,
        (state.get('pipeline_payload_identity') or {}).get('count'),
    )
    return state


def encode_postwrite_checkpoint(state, receipt, *, phase, context_checksum):
    if HISTORY_FIELDS.intersection(state):
        raise ValueError('premarket_postwrite_checkpoint_history_forbidden')
    envelope = {'schema_version': POSTWRITE_SCHEMA, 'source_receipt': receipt,
                'context_checksum': context_checksum, 'phase': phase, 'state': state}
    return compress_json(envelope, max_raw_bytes=PROJECTION_LIMIT,
                         error_prefix='premarket_postwrite_checkpoint')[0]
