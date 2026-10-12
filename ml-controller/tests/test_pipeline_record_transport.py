import json
from copy import deepcopy

import pytest

from services.pipeline_sequence_transport import (
    RECORD_KEY, compact_sequence_subsets, expand_sequence_subsets,
)


def sample():
    return {'payloads': [
        {'symbol': 'A', 'prices': [
            {'date': '2026-10-07', 'close': -0.0, 'extra': None},
            {'close': 1.0000000000000002, 'date': '2026-10-08'},
        ], 'indicators': [{}, {'nested': [1, {'x': 2}]}],
         'chips': [], 'market_env': {'risk': 0, 'history': {
             '2026-10-08': {'ratio': 1.0000000000000002},
             '2026-10-07': {'ratio': None, 'absent_on_other_day': 1},
         }}},
        {'symbol': 'B', 'prices': [{'date': '2026-10-08', 'close': 2.0}],
         'market_env': {'history': {}}},
    ]}


def test_wire_preserves_all_values_missing_null_order_and_ownership():
    original = sample()
    before = deepcopy(original)
    packed = compact_sequence_subsets(original)
    assert original == before and RECORD_KEY in packed
    wire = json.loads(json.dumps(packed))
    restored = expand_sequence_subsets(wire)
    assert json.dumps(restored, sort_keys=True) == json.dumps(before, sort_keys=True)
    assert list(restored['payloads'][0]['market_env']['history']) == ['2026-10-08', '2026-10-07']
    assert list(restored['payloads'][0]['prices'][1]) == ['close', 'date']
    restored['payloads'][0]['indicators'][1]['nested'][1]['x'] = 3
    assert original['payloads'][0]['indicators'][1]['nested'][1]['x'] == 2
    assert wire[RECORD_KEY]['tables']['0']['indicators']['rows'][1][1][0][1]['x'] == 2


@pytest.mark.parametrize('fault', [
    'count', 'bool_count', 'unknown_field', 'index_alias', 'index_outside',
    'duplicate_column', 'bad_layout', 'bool_layout', 'value_count',
    'duplicate_key', 'missing_key', 'duplicate_owner', 'unknown_schema',
])
def test_corrupt_record_tables_fail_closed(fault):
    p = compact_sequence_subsets(sample())
    meta = p[RECORD_KEY]
    table = meta['tables']['0']['prices']
    if fault == 'count': meta['row_count'] = 3
    elif fault == 'bool_count': meta['row_count'] = True
    elif fault == 'unknown_field': meta['tables']['0']['symbol'] = table
    elif fault == 'index_alias': meta['tables']['00'] = meta['tables'].pop('0')
    elif fault == 'index_outside': meta['tables']['2'] = meta['tables'].pop('0')
    elif fault == 'duplicate_column': table['columns'][0][1] = table['columns'][0][0]
    elif fault == 'bad_layout': table['rows'][0][0] = -1
    elif fault == 'bool_layout': table['rows'][0][0] = True
    elif fault == 'value_count': table['rows'][0][1].pop()
    elif fault == 'duplicate_key': meta['tables']['0']['market_env.history']['keys'] = ['x', 'x']
    elif fault == 'missing_key': meta['tables']['0']['market_env.history']['keys'].pop()
    elif fault == 'duplicate_owner': p['payloads'][0]['prices'] = []
    elif fault == 'unknown_schema': meta['schema_version'] = 'unknown'
    with pytest.raises(ValueError, match='pipeline_payload_records_'):
        expand_sequence_subsets(p)


def test_nonrecord_fields_remain_explicit_and_old_wire_still_reads():
    p = {'payloads': [{'symbol': 'A', 'prices': [1, 2], 'market_env': {'history': {'x': 1}}}]}
    assert compact_sequence_subsets(p) == p
    assert expand_sequence_subsets(p) == p


def test_encoding_an_already_encoded_packet_is_rejected():
    with pytest.raises(ValueError, match='already_encoded'):
        compact_sequence_subsets(compact_sequence_subsets(sample()))



def vector_sample():
    return {'payloads': [
        {'symbol': symbol, 'market_env': {'history': {
            'd1': {'market': 1.0000000000000002, 'stock': value, 'nested': [1]},
            'd2': {'market': -0.0, 'stock': value + 1, 'nested': [2]},
        }}} for symbol, value in [('A', 1), ('B', 3)] ]}


def test_shared_history_vectors_exact_and_independent_after_decode():
    from services.pipeline_sequence_transport import VECTOR_KEY
    original = vector_sample()
    packed = compact_sequence_subsets(original)
    assert len(packed[VECTOR_KEY]['pool']) == 4
    restored = expand_sequence_subsets(json.loads(json.dumps(packed)))
    assert json.dumps(restored, sort_keys=True) == json.dumps(original, sort_keys=True)
    restored['payloads'][0]['market_env']['history']['d1']['nested'][0] = 99
    assert restored['payloads'][1]['market_env']['history']['d1']['nested'] == [1]
    assert original == vector_sample()


@pytest.mark.parametrize('fault', ['schema','pool','owner','bool_index','outside','count','length','duplicate_rows','column'])
def test_corrupt_shared_history_vectors_fail_closed(fault):
    from services.pipeline_sequence_transport import VECTOR_KEY
    p = compact_sequence_subsets(vector_sample())
    v = p[VECTOR_KEY]
    if fault == 'schema': v['schema_version'] = 'unknown'
    elif fault == 'pool': v['pool'][0] = 1
    elif fault == 'owner': v['owners']['absent'] = v['owners'].pop('0.market_env.history')
    elif fault == 'bool_index': v['owners']['0.market_env.history']['vectors'][0] = True
    elif fault == 'outside': v['owners']['0.market_env.history']['vectors'][0] = len(v['pool'])
    elif fault == 'count': v['owners']['0.market_env.history']['count'] = True
    elif fault == 'length': v['pool'][0].pop()
    elif fault == 'duplicate_rows': p[RECORD_KEY]['tables']['0']['market_env.history']['rows'] = []
    elif fault == 'column': p[RECORD_KEY]['tables']['0']['market_env.history']['columns'][0].append('extra')
    with pytest.raises(ValueError, match='pipeline_payload_records_'):
        expand_sequence_subsets(p)
