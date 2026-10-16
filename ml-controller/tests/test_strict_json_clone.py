"""Strict JSON normalization parity and bounded-reader capture regressions."""
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path
import random

import pytest

from services.paired_nav_journal import digest, encode
from services.strict_json_clone import strict_json_clone


def legacy(value):
    return json.loads(encode(value))


@pytest.mark.parametrize('value', [
    None, True, False, 0, -(2**100), 2**100, 0.0, -0.0,
    [1.7976931348623157e308, 5e-324, 2.2250738585072014e-308, -1e-300],
    {'中文': '😀\\\n\t', 'empty': [[], {}, None], 'z': [1, 2]},
    (('tuple', 2), {'nested_tuple': (3, 4)}),
    {3: 'three', 1: 'one'}, {None: [1]}, {False: [2]}, {1.5: [3]},
    {'surrogate': '\ud800'}, {'\udfff': ['\ud800']},
    {'key_order': {'z': [1], 'a': [2]}},
])
def test_values_and_numeric_normalization_match_strict_stdlib(value):
    expected = legacy(value)
    actual = strict_json_clone(value)
    assert actual == expected
    assert encode(actual) == encode(expected)
    if isinstance(value, float) and value == 0.0:
        assert math.copysign(1, actual) == math.copysign(1, expected)


@pytest.mark.parametrize('value', [
    float('nan'), float('inf'), -float('inf'), {'v': float('nan')},
    object(), {'v': Decimal('1.2')}, {'bad': {1, 2}}, {('tuple',): 1},
    {'str': 1, 2: 3}, {None: 1, 'str': 2}, complex(1, 2),
])
def test_invalid_values_keep_stdlib_rejection_type(value):
    with pytest.raises(Exception) as expected:
        legacy(value)
    with pytest.raises(type(expected.value)):
        strict_json_clone(value)


@pytest.mark.parametrize('kind', ['dict', 'list', 'tuple'])
def test_cycles_stay_rejected(kind):
    value = {} if kind == 'dict' else []
    if kind == 'dict':
        value['cycle'] = value
    elif kind == 'tuple':
        pair = (value,)
        value.append(pair)
    else:
        value.append(value)
    with pytest.raises(ValueError, match='Circular reference'):
        strict_json_clone(value)


def test_repeated_aliases_become_independent_normalized_containers():
    shared = {'tuple': (1, 2), 'prices': [{'close': 3}]}
    source = {'left': shared, 'right': shared, 'rows': [shared, shared]}
    result = strict_json_clone(source)
    assert result == legacy(source)
    assert isinstance(result['left']['tuple'], list)
    result['left']['prices'][0]['close'] = 4
    result['rows'][0]['prices'].append({'close': 5})
    assert result['right']['prices'] == result['rows'][1]['prices'] == [{'close': 3}]
    assert shared == {'tuple': (1, 2), 'prices': [{'close': 3}]}


def test_deterministic_random_json_values_and_aliases_match_legacy():
    rng = random.Random(20261016)
    leaves = [None, True, False, 0, -0.0, 2**90, 5e-324, 1e308, '中文😀', '\ud800', '']
    def value(depth=0):
        if depth > 4 or rng.randrange(3) == 0:
            return rng.choice(leaves)
        if rng.randrange(2):
            return [value(depth + 1) for _ in range(rng.randrange(5))]
        return {f'key-{i}': value(depth + 1) for i in range(rng.randrange(5))}
    for _ in range(200):
        item = value()
        source = {'aliases': [item, item], 'another': item}
        expected = legacy(source)
        original = encode(source)
        actual = strict_json_clone(source)
        assert actual == expected and encode(actual) == encode(expected)
        assert encode(source) == original
        if isinstance(item, dict):
            actual['aliases'][0]['mutation'] = ['local']
            assert actual['aliases'][1] == actual['another'] == expected['another']
        elif isinstance(item, list):
            actual['aliases'][0].append({'mutation': ['local']})
            assert actual['aliases'][1] == actual['another'] == expected['another']


@pytest.mark.parametrize('value', [
    {-2: 'negative', .5: 'fraction', True: 'boolean'},
    {0: 'first', False: 'last', 0.0: 'final'},
    {-0.0: 'negative zero', 1: 'one'},
    {1: 'numeric', '1': 'text'}, {None: 1, 2: 2},
    {float('nan'): 'nan-key'},
])
def test_nonstring_key_coercion_collision_and_rejection_order(value):
    try:
        expected = legacy(value)
    except Exception as exc:
        with pytest.raises(type(exc)):
            strict_json_clone(value)
    else:
        actual = strict_json_clone(value)
        assert actual == expected and list(actual) == list(expected)


def test_deep_maps_use_narrow_stdlib_fallback_instead_of_a_lower_walk_limit():
    value = {'leaf': [1, 2, 3]}
    for _ in range(600):
        value = {'nested': value}
    assert encode(strict_json_clone(value)) == encode(legacy(value))
    for _ in range(1200):
        value = {'nested': value}
    # CPython versions have different C/Python recursion budgets. Match the
    # actual stdlib outcome instead of inventing a new arbitrary depth limit.
    try:
        expected = legacy(value)
    except RecursionError:
        with pytest.raises(RecursionError):
            strict_json_clone(value)
    else:
        assert encode(strict_json_clone(value)) == encode(expected)


def test_known_native_mapping_uses_bounded_normalization_and_plain_result(monkeypatch):
    import services.strict_json_clone as helper
    from services.streaming_json_reader import _SharedKeysDict
    source = _SharedKeysDict(rows=[{'index': i} for i in range(65)])
    clone_batch, sizes = helper._clone_batch, []
    def record(batch):
        sizes.append(len(batch))
        return clone_batch(batch)
    monkeypatch.setattr(helper, '_clone_batch', record)
    actual = strict_json_clone(source)
    assert type(actual) is dict and actual == legacy(source)
    assert sizes == [32, 32, 1]


def test_record_batches_do_not_build_a_whole_document(monkeypatch):
    import services.strict_json_clone as helper
    value = {'rows': [{'index': i, 'payload': 'x' * 1024} for i in range(100)]}
    original, sizes = helper._clone_batch, []
    def record(batch):
        sizes.append(len(batch))
        return original(batch)
    monkeypatch.setattr(helper, '_clone_batch', record)
    assert strict_json_clone(value) == legacy(value)
    assert sizes == [32, 32, 32, 4]


def test_capture_all_four_roundtrips_preserve_formal_mutation_and_checksum(monkeypatch):
    from services import paired_nav_recommendation_path as path
    monkeypatch.setattr(path, 'verify_screener_recommendation_source', lambda value: None)
    packets, results = [], []
    original = {'screener_recs': [{'symbol': '2330'}],
        'payloads': [{'symbol': '2330', 'prices': [{'close': 3}]}],
        'predictions': {'2330': {'score': 1, 'tuple': (1, 2)}},
        'filter_options': {}, 'l2_summary': {'status': 'blocked'}}
    for clone in (legacy, strict_json_clone):
        inputs = deepcopy(original)
        calls = []
        def checked(value):
            calls.append(value)
            return clone(value)
        monkeypatch.setattr(path, 'strict_json_clone', checked)
        def rows(seeds, predictions, payloads, **kwargs):
            predictions['2330']['score'] = 2
            return [{'symbol': '2330', 'evidence': ('kept', 3)}], 0, {}
        result, packet = path.run_and_capture_recommendation_path(inputs=inputs,
            candidate_reader=lambda: {'status': 'selected', 'empty': ()},
            filter_rows=rows, enrich_l2=lambda rows, *a, **kw: rows,
            enrich_core=lambda rows, *a, **kw: rows)
        assert len(calls) == 4 and packet['status'] == 'recommendation_context_captured'
        assert packet['inputs']['predictions']['2330']['score'] == 1
        assert packet['post_predictions']['2330']['score'] == inputs['predictions']['2330']['score'] == 2
        assert packet['expected']['recommendations'][0]['evidence'] == ['kept', 3]
        assert packet['l3_candidate_selection']['empty'] == []
        packets.append(packet)
        results.append(result)
    assert packets[0] == packets[1] and digest(packets[0]) == digest(packets[1])
    assert results[0] == results[1]
    helper = Path(path.__file__).with_name('strict_json_clone.py')
    assert path.recommendation_source_identity()['strict_json_clone.py'] == hashlib.sha256(helper.read_bytes()).hexdigest()
