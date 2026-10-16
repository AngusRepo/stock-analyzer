"""Stage identities retain exact original JSON bytes and bounded batching."""
import hashlib
import json
import pytest

from app.pipeline_prediction_stages import digest


def original(value):
    hasher = hashlib.sha256()
    for part in json.JSONEncoder(sort_keys=True, ensure_ascii=False,
            separators=(',', ':'), allow_nan=False).iterencode(value):
        hasher.update(part.encode('utf-8'))
    return hasher.hexdigest()


@pytest.mark.parametrize('value', [None, True, -0.0, 10**100, 5e-324,
    {'中文': ['台股', -0.0, 1e-310, 1e308, 10**100]},
    {1: 'one', 2: 'two'}, {False: 'no', True: 'yes'},
    [{'index': n, 'series': [float(n), None]} for n in range(103)],
    {'tuple': (1, {'value': 2})}, {'duplicate': [1, 1]}])
def test_digest_exactly_matches_original(value):
    assert digest(value) == original(value)


@pytest.mark.parametrize('value', [float('nan'), float('inf'), -float('inf'),
    {'x': object()}, {1: 'mixed', 'a': 'keys'}, '\ud800'])
def test_original_rejections_are_not_relaxed(value):
    with pytest.raises(Exception) as failure:
        original(value)
    with pytest.raises(type(failure.value)):
        digest(value)


def test_circular_documents_remain_rejected():
    value = []
    value.append(value)
    with pytest.raises(ValueError):
        digest(value)


def test_uses_the_existing_bounded_writer_without_changing_source(monkeypatch):
    import services.pipeline_json_transport as transport
    calls = []
    real = transport.iter_json_bytes
    def observed(value, **options):
        calls.append(options)
        yield from real(value, **options)
    monkeypatch.setattr(transport, 'iter_json_bytes', observed)
    value = [{'x': n} for n in range(100)]
    assert digest(value) == original(value)
    assert calls == [dict(sort_keys=True, allow_nan=False, default=None)]
