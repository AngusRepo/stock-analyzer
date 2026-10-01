"""Lossless wire references for repeated model sequence subsets.

Only byte-equivalent rows of the primary sequence pool may be referenced.
Hydration copies rows so model-local mutations retain the old JSON semantics.
"""
from __future__ import annotations
from copy import deepcopy

KEY = 'sequence_subset_transport'
SCHEMA = 'pipeline-sequence-subset-indices-v1'
FIELDS = ('sequence_model_series_by_model', 'active8_shadow_sequence_series_by_model')


def compact_sequence_subsets(payload):
    payload = _compact_common_fields(payload)
    if KEY in payload:
        raise ValueError('pipeline_sequence_transport_already_encoded')
    series = payload.get('sequence_series')
    if not isinstance(series, list) or not series:
        return payload
    lookup = {}
    for i, row in enumerate(series):
        symbol = str(row.get('symbol') or row.get('stock_id') or '') if isinstance(row, dict) else ''
        if not symbol or symbol in lookup:
            raise ValueError('pipeline_sequence_transport_pool_invalid')
        lookup[symbol] = i
    indices = {}
    for field in FIELDS:
        if field not in payload:
            continue
        groups = payload[field]
        if not isinstance(groups, dict):
            raise ValueError('pipeline_sequence_transport_groups_invalid')
        mapped = {}
        for model, rows in groups.items():
            if not isinstance(rows, list):
                raise ValueError('pipeline_sequence_transport_rows_invalid')
            positions = []
            for row in rows:
                symbol = str(row.get('symbol') or row.get('stock_id') or '') if isinstance(row, dict) else ''
                pos = lookup.get(symbol)
                if pos is None or row != series[pos]:
                    # Different values must stay explicit; never substitute by symbol alone.
                    return payload
                positions.append(pos)
            mapped[model] = positions
        indices[field] = mapped
    if not indices:
        return payload
    result = {k:v for k,v in payload.items() if k not in indices}
    result[KEY] = {'schema_version':SCHEMA, 'pool_count':len(series), 'fields':indices}
    return result


def expand_sequence_subsets(payload):
    payload = _expand_common_fields(payload)
    if KEY not in payload:
        return payload
    meta = payload[KEY]
    series = payload.get('sequence_series')
    if (not isinstance(meta, dict) or set(meta) != {'schema_version','pool_count','fields'}
            or meta.get('schema_version') != SCHEMA or not isinstance(series,list)
            or type(meta.get('pool_count')) is not int or meta['pool_count'] != len(series)
            or not isinstance(meta.get('fields'),dict) or not meta['fields']
            or set(meta['fields']) - set(FIELDS)):
        raise ValueError('pipeline_sequence_transport_manifest_invalid')
    result = {k:v for k,v in payload.items() if k != KEY}
    for field, groups in meta['fields'].items():
        if field in result or not isinstance(groups,dict):
            raise ValueError('pipeline_sequence_transport_duplicate_owner')
        result[field] = {}
        for model, positions in groups.items():
            if (not isinstance(positions,list) or len(positions)>len(series)
                    or any(type(i) is not int or i<0 or i>=len(series) for i in positions)
                    or len(set(positions)) != len(positions)):
                raise ValueError('pipeline_sequence_transport_index_invalid')
            result[field][model] = [deepcopy(series[i]) for i in positions]
    return result


COMMON_KEY = 'payload_common_transport'
COMMON_SCHEMA = 'pipeline-payload-common-v1'
COMMON_FIELDS = ('trading_config', 'adaptive_params', 'lifecycle_weights', 'barrier_params', 'runtime_options')


def _compact_common_fields(payload):
    if COMMON_KEY in payload:
        raise ValueError('pipeline_payload_common_already_encoded')
    rows = payload.get('payloads')
    if not isinstance(rows, list) or len(rows) < 2 or not all(isinstance(r, dict) for r in rows):
        return payload
    common = {key: rows[0][key] for key in COMMON_FIELDS
              if key in rows[0] and all(key in row and row[key] == rows[0][key] for row in rows)}
    if not common:
        return payload
    return {**payload, 'payloads': [{k: v for k, v in row.items() if k not in common} for row in rows],
            COMMON_KEY: {'schema_version': COMMON_SCHEMA, 'row_count': len(rows), 'fields': common}}


def _expand_common_fields(payload):
    if COMMON_KEY not in payload:
        return payload
    meta = payload[COMMON_KEY]
    rows = payload.get('payloads')
    if (not isinstance(meta, dict) or set(meta) != {'schema_version', 'row_count', 'fields'}
            or meta.get('schema_version') != COMMON_SCHEMA or not isinstance(rows, list)
            or type(meta.get('row_count')) is not int or meta['row_count'] != len(rows)
            or not isinstance(meta.get('fields'), dict) or not meta['fields']
            or set(meta['fields']) - set(COMMON_FIELDS)):
        raise ValueError('pipeline_payload_common_manifest_invalid')
    fields = meta['fields']
    if any(not isinstance(row, dict) or set(row).intersection(fields) for row in rows):
        raise ValueError('pipeline_payload_common_duplicate_owner')
    return {**{k: v for k, v in payload.items() if k != COMMON_KEY},
            'payloads': [{**row, **deepcopy(fields)} for row in rows]}
