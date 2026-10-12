"""Lossless wire references for repeated model sequence subsets.

Only byte-equivalent rows of the primary sequence pool may be referenced.
Hydration copies rows so model-local mutations retain the old JSON semantics.
"""
from __future__ import annotations
from copy import deepcopy
import hashlib
import json

KEY = 'sequence_subset_transport'
SCHEMA = 'pipeline-sequence-subset-indices-v1'
FIELDS = ('sequence_model_series_by_model', 'active8_shadow_sequence_series_by_model')


def compact_sequence_subsets(payload):
    payload = _compact_record_vectors(_compact_record_fields(_compact_common_fields(payload)))
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
    payload = _expand_common_fields(_expand_record_fields(_expand_record_vectors(payload)))
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


RECORD_KEY = 'payload_record_transport'
RECORD_SCHEMA = 'pipeline-payload-record-tables-v1'
RECORD_FIELDS = ('prices', 'indicators', 'chips', 'market_env.history')


def _pack_records(value, *, mapping=False):
    if not isinstance(value, dict if mapping else list) or not value:
        return None
    if mapping and not all(isinstance(key, str) for key in value):
        return None
    records = list(value.values()) if mapping else value
    if len(records) < 2:
        return None  # One record has no repeated column names to remove.
    if not all(isinstance(row, dict) and all(isinstance(k, str) for k in row) for row in records):
        return None
    layouts, lookup, rows = [], {}, []
    for row in records:
        columns = tuple(row)  # Retain even dictionary insertion order.
        if columns not in lookup:
            lookup[columns] = len(layouts)
            layouts.append(list(columns))
        rows.append([lookup[columns], [row[key] for key in columns]])
    table = {'columns': layouts, 'rows': rows}
    if mapping:
        table['keys'] = list(value)
    return table


def _unpack_records(table, *, mapping=False):
    expected = {'columns', 'rows', 'keys'} if mapping else {'columns', 'rows'}
    if not isinstance(table, dict) or set(table) != expected:
        raise ValueError('pipeline_payload_records_table_invalid')
    columns, rows = table['columns'], table['rows']
    if (not isinstance(columns, list) or not columns or not isinstance(rows, list) or not rows
            or any(not isinstance(c, list) or any(not isinstance(k, str) for k in c)
                   or len(set(c)) != len(c) for c in columns)):
        raise ValueError('pipeline_payload_records_columns_invalid')
    restored = []
    for row in rows:
        if (not isinstance(row, list) or len(row) != 2 or type(row[0]) is not int
                or not 0 <= row[0] < len(columns) or not isinstance(row[1], list)
                or len(row[1]) != len(columns[row[0]])):
            raise ValueError('pipeline_payload_records_row_invalid')
        restored.append(dict(zip(columns[row[0]], deepcopy(row[1]))))
    if not mapping:
        return restored
    keys = table['keys']
    if (not isinstance(keys, list) or len(keys) != len(restored)
            or any(not isinstance(k, str) for k in keys) or len(set(keys)) != len(keys)):
        raise ValueError('pipeline_payload_records_keys_invalid')
    return dict(zip(keys, restored))


def _compact_record_fields(payload):
    if RECORD_KEY in payload:
        raise ValueError('pipeline_payload_records_already_encoded')
    source = payload.get('payloads')
    if not isinstance(source, list) or not source or not all(isinstance(r, dict) for r in source):
        return payload
    rows, tables = [], {}
    for index, original in enumerate(source):
        row, fields = dict(original), {}
        for field in RECORD_FIELDS:
            mapping = field == 'market_env.history'
            owner = original.get('market_env') if mapping else original
            key = 'history' if mapping else field
            if not isinstance(owner, dict) or key not in owner:
                continue
            table = _pack_records(owner[key], mapping=mapping)
            if table is None:
                continue
            fields[field] = table
            if mapping:
                row['market_env'] = {k: v for k, v in owner.items() if k != key}
            else:
                del row[key]
        if fields:
            tables[str(index)] = fields
        rows.append(row)
    if not tables:
        return payload
    return {**payload, 'payloads': rows, RECORD_KEY: {
        'schema_version': RECORD_SCHEMA, 'row_count': len(rows), 'tables': tables}}


def _expand_record_fields(payload):
    if RECORD_KEY not in payload:
        return payload
    meta, rows = payload[RECORD_KEY], payload.get('payloads')
    if (not isinstance(meta, dict) or set(meta) != {'schema_version', 'row_count', 'tables'}
            or meta.get('schema_version') != RECORD_SCHEMA or not isinstance(rows, list)
            or type(meta.get('row_count')) is not int or meta['row_count'] != len(rows)
            or not all(isinstance(r, dict) for r in rows)
            or not isinstance(meta.get('tables'), dict) or not meta['tables']):
        raise ValueError('pipeline_payload_records_manifest_invalid')
    restored = [dict(row) for row in rows]
    for index, fields in meta['tables'].items():
        if (not isinstance(index, str) or not index.isascii() or not index.isdigit()
                or str(int(index)) != index or int(index) >= len(rows)
                or not isinstance(fields, dict) or not fields or set(fields) - set(RECORD_FIELDS)):
            raise ValueError('pipeline_payload_records_owner_invalid')
        row = restored[int(index)]
        for field, table in fields.items():
            mapping = field == 'market_env.history'
            owner = row.get('market_env') if mapping else row
            key = 'history' if mapping else field
            if not isinstance(owner, dict) or key in owner:
                raise ValueError('pipeline_payload_records_duplicate_owner')
            value = _unpack_records(table, mapping=mapping)
            if mapping:
                row['market_env'] = {**owner, key: value}
            else:
                row[key] = value
    return {**{k: v for k, v in payload.items() if k != RECORD_KEY}, 'payloads': restored}


VECTOR_KEY = 'payload_record_vectors'
VECTOR_SCHEMA = 'pipeline-record-vectors-v1'


def _compact_record_vectors(payload):
    """Share only JSON-byte-identical record columns across symbols."""
    if VECTOR_KEY in payload:
        raise ValueError('pipeline_payload_records_vectors_already_encoded')
    meta = payload.get(RECORD_KEY)
    if not meta:
        return payload
    pool, lookup, owners = [], {}, {}
    tables = dict(meta['tables'])
    for owner, fields in meta['tables'].items():
        for field, table in fields.items():
            if not table or len(table['columns']) != 1:
                continue
            vectors = []
            for column in range(len(table['columns'][0])):
                values = [row[1][column] for row in table['rows']]
                encoded = json.dumps(values, ensure_ascii=False, separators=(',', ':'), default=str)
                digest = hashlib.sha256(encoded.encode('utf-8')).digest()
                index = lookup.get(digest)
                if index is not None:
                    # Hash is an accelerator, never an equality substitute.
                    if json.dumps(pool[index], ensure_ascii=False, separators=(',', ':'), default=str) != encoded:
                        raise ValueError('pipeline_payload_records_vector_hash_collision')
                else:
                    index = len(pool)
                    lookup[digest] = index
                    pool.append(values)
                vectors.append(index)
            owners[owner + '.' + field] = {'count': len(table['rows']), 'vectors': vectors}
            tables[owner] = {**tables[owner], field: {k:v for k,v in table.items() if k != 'rows'}}
    if not owners:
        return payload
    return {**payload, RECORD_KEY: {**meta, 'tables': tables}, VECTOR_KEY: {
        'schema_version': VECTOR_SCHEMA, 'pool': pool, 'owners': owners}}


def _expand_record_vectors(payload):
    if VECTOR_KEY not in payload:
        return payload
    vectors, meta = payload[VECTOR_KEY], payload.get(RECORD_KEY)
    if (not isinstance(vectors, dict) or set(vectors) != {'schema_version', 'pool', 'owners'}
            or vectors.get('schema_version') != VECTOR_SCHEMA
            or not isinstance(vectors.get('pool'), list)
            or not all(isinstance(v, list) for v in vectors['pool'])
            or not isinstance(vectors.get('owners'), dict) or not vectors['owners']
            or not isinstance(meta, dict) or not isinstance(meta.get('tables'), dict)):
        raise ValueError('pipeline_payload_records_vectors_invalid')
    tables = dict(meta['tables'])
    for address, binding in vectors['owners'].items():
        if not isinstance(address, str) or '.' not in address:
            raise ValueError('pipeline_payload_records_vector_owner_invalid')
        owner, field = address.split('.', 1)
        fields = tables.get(owner)
        table = fields.get(field) if isinstance(fields, dict) else None
        mapping = field == 'market_env.history'
        expected = {'columns', 'keys'} if mapping else {'columns'}
        if (field not in RECORD_FIELDS or not isinstance(table, dict) or set(table) != expected
                or not isinstance(table['columns'], list) or len(table['columns']) != 1
                or not isinstance(table['columns'][0], list)
                or not isinstance(binding, dict) or set(binding) != {'count', 'vectors'}
                or type(binding['count']) is not int or binding['count'] < 2
                or not isinstance(binding['vectors'], list)
                or len(binding['vectors']) != len(table['columns'][0])
                or (mapping and (not isinstance(table['keys'], list) or len(table['keys']) != binding['count']))
                or any(type(i) is not int or not 0 <= i < len(vectors['pool'])
                       or len(vectors['pool'][i]) != binding['count'] for i in binding['vectors'])):
            raise ValueError('pipeline_payload_records_vector_binding_invalid')
        rows = [[0, [vectors['pool'][i][r] for i in binding['vectors']]] for r in range(binding['count'])]
        tables[owner] = {**fields, field: {**table, 'rows': rows}}
    return {**{k:v for k,v in payload.items() if k != VECTOR_KEY}, RECORD_KEY: {**meta, 'tables': tables}}
