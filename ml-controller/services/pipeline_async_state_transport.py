from __future__ import annotations

import gzip
import hashlib
import json
from io import BytesIO
from typing import Any

from services.pipeline_json_transport import compress_json
from services.pipeline_json_transport import iter_json_bytes


STATE_SCHEMA_V1 = "pipeline-async-state-v1"
STATE_SCHEMA_V2 = "pipeline-async-state-v2"
STATE_SCHEMA_V3 = "pipeline-async-state-v3"
STATE_SCHEMA_V4 = "pipeline-async-state-v4"
PAYLOAD_IDENTITY_SCHEMA = "pipeline-payload-identity-v1"
_COMMON_FIELDS = ('market_env', 'trading_config', 'adaptive_params',
                  'lifecycle_weights', 'barrier_params')


def _history_digest(value):
    checksum = hashlib.sha256()
    for chunk in iter_json_bytes(value, sort_keys=True):
        checksum.update(chunk)
    return checksum.hexdigest()


def _string_key_maps(value, active=None):
    """Leave legacy key coercion/duplicate-key normalization on its old wire."""
    if not isinstance(value, (dict, list, tuple)):
        return True
    active = active if active is not None else set()
    identity = id(value)
    if identity in active:
        return False
    active.add(identity)
    try:
        if isinstance(value, dict):
            return all(isinstance(key, str) for key in value) and all(
                _string_key_maps(item, active) for item in value.values())
        return all(_string_key_maps(item, active) for item in value)
    finally:
        active.remove(identity)


def _shared_history_wire(payload):
    """Pool identical market history wire values missing from top-level context.

    History sourced from payload_source_observations is commonly shared by the
    producer but absent from state.market_env. V3 cannot reference it there.
    Preserve every row's outer values and unequal histories; only transport
    changes. Legacy JSON readers need the explicitly versioned V4 decoder.
    """
    if payload.get('schema_version') not in (STATE_SCHEMA_V1, STATE_SCHEMA_V2, STATE_SCHEMA_V3):
        return payload
    state = payload.get('state') or {}
    rows = state.get('payloads')
    if not isinstance(rows, list):
        return payload
    reserved = ('history_source_schema', 'payload_history_pool', 'payload_history_refs')
    if any(key in payload for key in reserved):
        raise ValueError('pipeline_shared_history_reserved_metadata')
    identities, groups, histories = {}, {}, {}
    for index, row in enumerate(rows):
        market = row.get('market_env') if isinstance(row, dict) else None
        history = market.get('history') if isinstance(market, dict) else None
        if not isinstance(history, list):
            continue
        found = identities.get(id(history))
        if found is None and not _string_key_maps(history):
            continue
        key = found[1] if found is not None else _history_digest(history)
        identities[id(history)] = (history, key)
        groups.setdefault(key, []).append(index)
        histories.setdefault(key, history)
    repeated = {key: indexes for key, indexes in groups.items() if len(indexes) > 1}
    if not repeated:
        return payload
    compact = list(rows)
    refs = []
    for key, indexes in repeated.items():
        for index in indexes:
            row = rows[index]
            compact[index] = {**row, 'market_env': {k: v for k, v in row['market_env'].items() if k != 'history'}}
            refs.append({'index': index, 'history': key})
    return {**payload, 'schema_version': STATE_SCHEMA_V4,
            'history_source_schema': payload['schema_version'],
            'payload_history_pool': {key: histories[key] for key in repeated},
            'payload_history_refs': refs, 'state': {**state, 'payloads': compact}}


def _restore_shared_history(payload):
    if payload.get('schema_version') != STATE_SCHEMA_V4:
        return payload
    source = payload.get('history_source_schema')
    pool, refs = payload.get('payload_history_pool'), payload.get('payload_history_refs')
    state = payload.get('state')
    rows = state.get('payloads') if isinstance(state, dict) else None
    if (source not in (STATE_SCHEMA_V1, STATE_SCHEMA_V2, STATE_SCHEMA_V3)
            or not isinstance(pool, dict) or not pool or not isinstance(refs, list) or not refs
            or not isinstance(rows, list)):
        raise ValueError('pipeline_shared_history_metadata_invalid')
    for key, history in pool.items():
        if not isinstance(history, list) or key != _history_digest(history):
            raise ValueError('pipeline_shared_history_checksum_invalid')
    seen, used = set(), set()
    for ref in refs:
        if not isinstance(ref, dict) or set(ref) != {'index', 'history'}:
            raise ValueError('pipeline_shared_history_reference_invalid')
        index, key = ref['index'], ref['history']
        if (type(index) is not int or not 0 <= index < len(rows) or index in seen
                or not isinstance(key, str) or key not in pool or not isinstance(rows[index], dict)):
            raise ValueError('pipeline_shared_history_reference_invalid')
        market = rows[index].get('market_env')
        if not isinstance(market, dict) or 'history' in market:
            raise ValueError('pipeline_shared_history_conflict')
        market['history'] = pool[key]
        seen.add(index); used.add(key)
    if used != set(pool):
        raise ValueError('pipeline_shared_history_unused_pool')
    for key in ('history_source_schema', 'payload_history_pool', 'payload_history_refs'):
        payload.pop(key)
    payload['schema_version'] = source
    return payload


def _shared_context_wire(payload):
    """Reference identical producer objects; never drop or coalesce unequal values."""
    if payload.get('schema_version') not in (STATE_SCHEMA_V1, STATE_SCHEMA_V2):
        return payload
    state = payload.get('state') or {}
    rows = state.get('payloads')
    if not isinstance(rows, list):
        return payload
    refs, compact = [], []
    common_market = state.get('market_env')
    common_market = common_market if isinstance(common_market, dict) else {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            return payload  # Original validator retains its error contract.
        fields = [key for key in _COMMON_FIELDS if isinstance(state.get(key), (dict, list))
                  and row.get(key) is state[key]]
        market = row.get('market_env')
        nested = ([key for key, value in common_market.items()
                   if isinstance(value, (dict, list)) and market.get(key) is value]
                  if isinstance(market, dict) and 'market_env' not in fields else [])
        if not fields and not nested:
            compact.append(row)
            continue
        value = {key: value for key, value in row.items() if key not in fields}
        if nested:
            value['market_env'] = {key: value for key, value in market.items() if key not in nested}
        compact.append(value)
        refs.append({'index': index, 'fields': fields, 'market_fields': nested})
    if not refs:
        return payload
    if 'source_schema' in payload or 'payload_context_refs' in payload:
        raise ValueError('pipeline_shared_context_reserved_metadata')
    return {**payload, 'schema_version': STATE_SCHEMA_V3,
            'source_schema': payload['schema_version'], 'payload_context_refs': refs,
            'state': {**state, 'payloads': compact}}


def _restore_shared_context(payload):
    if payload.get('schema_version') != STATE_SCHEMA_V3:
        return payload
    state, refs = payload.get('state'), payload.get('payload_context_refs')
    source = payload.get('source_schema')
    if source not in (STATE_SCHEMA_V1, STATE_SCHEMA_V2) or not isinstance(state, dict) or not isinstance(refs, list):
        raise ValueError('pipeline_shared_context_metadata_invalid')
    rows, seen = state.get('payloads'), set()
    if not isinstance(rows, list):
        raise ValueError('pipeline_shared_context_rows_invalid')
    for ref in refs:
        if not isinstance(ref, dict) or set(ref) != {'index', 'fields', 'market_fields'}:
            raise ValueError('pipeline_shared_context_reference_invalid')
        index, fields, nested = ref['index'], ref['fields'], ref['market_fields']
        if (type(index) is not int or not 0 <= index < len(rows) or index in seen
                or not isinstance(fields, list) or not isinstance(nested, list)
                or any(not isinstance(key, str) for key in fields + nested)
                or len(fields) != len(set(fields)) or len(nested) != len(set(nested))
                or any(key not in _COMMON_FIELDS for key in fields)
                or not isinstance(rows[index], dict)):
            raise ValueError('pipeline_shared_context_reference_invalid')
        seen.add(index)
        row = rows[index]
        for key in fields:
            if key in row or not isinstance(state.get(key), (dict, list)):
                raise ValueError('pipeline_shared_context_conflict')
            row[key] = state[key]
        if nested:
            market, common = row.get('market_env'), state.get('market_env')
            if 'market_env' in fields or not isinstance(market, dict) or not isinstance(common, dict):
                raise ValueError('pipeline_shared_context_conflict')
            for key in nested:
                if key in market or not isinstance(common.get(key), (dict, list)):
                    raise ValueError('pipeline_shared_context_conflict')
                market[key] = common[key]
    payload.pop('source_schema');payload.pop('payload_context_refs')
    payload['schema_version'] = source
    return payload


def _ordered_symbols(payloads: list[dict[str, Any]]) -> list[str]:
    symbols = [
        str(row.get("symbol") or row.get("stock_id") or "").strip()
        for row in payloads
        if isinstance(row, dict)
    ]
    if not payloads or len(symbols) != len(payloads) or any(not symbol for symbol in symbols):
        raise ValueError("pipeline_payload_identity_symbols_invalid")
    if len(set(symbols)) != len(symbols):
        raise ValueError("pipeline_payload_identity_symbols_duplicate")
    return symbols


def build_pipeline_payload_identity(payloads: list[dict[str, Any]]) -> dict[str, Any]:
    symbols = _ordered_symbols(payloads)
    encoded = json.dumps(
        symbols,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "schema_version": PAYLOAD_IDENTITY_SCHEMA,
        "count": len(payloads),
        "ordered_symbols_sha256": hashlib.sha256(encoded).hexdigest(),
    }


def validate_pipeline_payload_identity(state: dict[str, Any]) -> list[dict[str, Any]]:
    payloads = state.get("payloads") if isinstance(state.get("payloads"), list) else []
    if not payloads or any(not isinstance(row, dict) for row in payloads):
        raise ValueError("pipeline_payload_identity_payloads_incomplete")

    contract = state.get("pipeline_payload_identity")
    if isinstance(contract, dict):
        expected = build_pipeline_payload_identity(payloads)
        if contract != expected:
            raise ValueError("pipeline_payload_identity_contract_mismatch")
        return payloads

    # Backward compatibility for immutable v1 artifacts. New writers must use
    # the compact identity contract and must not serialize the payload twice.
    legacy = state.get("l3_payloads") if isinstance(state.get("l3_payloads"), list) else []
    if not legacy or len(legacy) != len(payloads):
        raise ValueError("pipeline_payload_identity_legacy_incomplete")
    if _ordered_symbols(legacy) != _ordered_symbols(payloads):
        raise ValueError("pipeline_payload_identity_legacy_mismatch")
    return payloads


def encode_pipeline_state_envelope(payload: dict[str, Any]) -> bytes:
    compressed, _, _ = compress_json(_shared_history_wire(_shared_context_wire(payload)))
    return compressed


def decode_pipeline_state_envelope(raw: bytes) -> dict[str, Any]:
    from services.streaming_json_reader import load
    from ijson.common import JSONError
    legacy=False
    try:
        with (gzip.GzipFile(fileobj=BytesIO(raw)) if raw.startswith(b"\x1f\x8b") else BytesIO(raw)) as source:
            payload=load(source)
    except JSONError:
        legacy=True
    if legacy:
        # Legacy envelopes accepted JSON NaN/Infinity. Preserve that contract;
        # ordinary full states avoid the document-sized raw + Unicode copies.
        decoded=(gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw).decode('utf-8-sig')
        payload=json.loads(decoded)
    payload = _restore_shared_context(_restore_shared_history(payload))
    if payload.get("schema_version") not in {STATE_SCHEMA_V1, STATE_SCHEMA_V2}:
        raise ValueError("pipeline_async_state_schema_invalid")
    state = payload.get("state")
    if not isinstance(state, dict):
        raise ValueError("pipeline_async_state_missing")
    validate_pipeline_payload_identity(state)
    # Producers share these read-only contexts; JSON wire transport loses that
    # identity and otherwise retains hundreds of identical copies after restore.
    for row in state['payloads']:
        for key in ('market_env', 'trading_config', 'adaptive_params',
                    'lifecycle_weights', 'barrier_params'):
            common = state.get(key)
            if isinstance(common, dict) and (row.get(key) is common or row.get(key) == common):
                row[key] = common
        # Individual revenue/margin overrides keep their own outer mapping.
        # Only identical nested market-wide structures regain producer sharing.
        market = row.get('market_env')
        common_market = state.get('market_env') or {}
        if isinstance(market, dict):
            for key, common in common_market.items():
                if isinstance(common, (dict, list)) and (market.get(key) is common or market.get(key) == common):
                    market[key] = common
    return payload
