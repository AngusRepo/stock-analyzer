import pytest

from services.native_paper_sandbox import PrivatePaperStore
from services import kv_client
from test_native_paper_sandbox import checksum, frame


def test_private_delete_and_expiry_never_resurrect_live_kv():
    f = {**frame(), 'capture_kv_reads': True,
         'kv_read_policy': {'source': ['test', 'expire'], 'private': ['pending:']}}
    reads = []
    class Capture:
        def read(self, op, request, frame):
            reads.append(request)
            assert op == 'source_kv'
            return {'request': request, 'response': 'original'}
    raw = 'CREATE TABLE t(id INTEGER);'
    store = PrivatePaperStore(raw, checksum(raw), {f['input_id']: f}, capture_source=Capture())
    try:
        store.dispatch('frame_input', {**f, 'now_ms': 1788739200000})
        store.dispatch('frame_begin', {})
        assert store.dispatch('kv_get', {'key': 'test'}) == 'original'
        assert store.dispatch('kv_get', {'key': 'pending:buy'}) is None
        with pytest.raises(ValueError, match='kv_owner_unregistered'):
            store.dispatch('kv_get', {'key': 'unknown'})
        store.dispatch('kv_delete', {'key': 'test'})
        assert store.dispatch('kv_get', {'key': 'test'}) is None
        store.dispatch('kv_put', {'key': 'expire', 'value': 'private', 'options': {'expirationTtl': 1}})
        store.now_ms += 2000
        assert store.dispatch('kv_get', {'key': 'expire'}) is None
        assert len(reads) == 1
    finally:
        store.db.close()


@pytest.mark.parametrize('status', [401, 429, 500])
def test_strict_kv_error_cannot_be_misreported_as_missing(monkeypatch, status):
    monkeypatch.setattr(kv_client, '_check_env', lambda: None)
    class Response:
        status_code = status
        text = 'sensitive synthetic response'
    monkeypatch.setattr(kv_client.httpx, 'get', lambda *args, **kwargs: Response())
    with pytest.raises(RuntimeError, match=f'^kv_read_http_failed:{status}$'):
        kv_client.get('test', strict=True)


def test_strict_json_transport_and_decode_failure_are_not_missing(monkeypatch):
    monkeypatch.setattr(kv_client, 'get', lambda *args, **kwargs: '{bad-json')
    with pytest.raises(RuntimeError, match='kv_read_json_invalid'):
        kv_client.get_json('trading:risk_config', strict=True)
    assert kv_client.get_json('trading:risk_config', default=None) is None
    monkeypatch.setattr(kv_client, '_check_env', lambda: None)
    def fail(*args, **kwargs):
        raise kv_client.httpx.ReadTimeout('synthetic URL must not be printed')
    monkeypatch.undo()
    monkeypatch.setattr(kv_client, '_check_env', lambda: None)
    monkeypatch.setattr(kv_client.httpx, 'get', fail)
    with pytest.raises(RuntimeError, match='^kv_read_transport_failed$'):
        kv_client.get_json('trading:risk_config', strict=True)
