"""Real HTTP client scope and complete original dependency batch regression."""
from contextvars import Context
from types import SimpleNamespace
import json
import httpx
import pytest

from services import d1_client as d1, daily_nav_read_receipt as receipt


def test_all_53_original_checks_and_retry_share_one_transport(monkeypatch, caplog):
    clients, requests = [], []
    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            raise httpx.ConnectError('private-token-or-sql-must-not-be-logged', request=request)
        return httpx.Response(200, json={'success': True, 'result': [
            {'success': True, 'results': {'columns': ['i'], 'rows': [[s['params'][0]]]}}
            for s in body['batch']]})
    def client():
        value = httpx.Client(transport=httpx.MockTransport(handle))
        clients.append(value)
        return value
    def forbidden(*args, **kwargs):
        pytest.fail('top-level post bypassed the scoped client')
    monkeypatch.setattr(d1, 'httpx', SimpleNamespace(Client=client, post=forbidden, RequestError=httpx.RequestError))
    monkeypatch.setattr(d1, '_check_env', lambda *args: None)
    monkeypatch.setattr(d1, '_sleep_before_retry', lambda *args: None)
    reads = [{'sql': 'SELECT ? AS i', 'params': [i], 'checksum': receipt._digest([{'i': i}])}
             for i in range(53)]
    with d1.read_connection_scope():
        first = d1._READ_HTTP.get()
        with d1.read_connection_scope():
            assert d1._READ_HTTP.get() is first
            assert receipt.unchanged(SimpleNamespace(database_id='test-learning'), reads)
        assert not first.is_closed
        # A separate request context has its own client, never the current one.
        def independent():
            with d1.read_connection_scope():
                assert d1._READ_HTTP.get() is not first
        Context().run(independent)
        assert d1._READ_HTTP.get() is first
    assert len(clients) == 2 and all(c.is_closed for c in clients)
    assert d1._READ_HTTP.get() is None
    assert [len(r['batch']) for r in requests] == [25, 25, 25, 3]
    assert requests[0] == requests[1]
    assert 'scoped_raw_transport_retry' in caplog.text
    assert 'private-token' not in caplog.text


def test_scope_closes_and_resets_after_failed_request(monkeypatch):
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(403, text='denied')))
    monkeypatch.setattr(d1, 'httpx', SimpleNamespace(Client=lambda: client, RequestError=httpx.RequestError))
    monkeypatch.setattr(d1, '_check_env', lambda *args: None)
    with pytest.raises(RuntimeError, match='HTTP 403'):
        with d1.read_connection_scope():
            d1.read_raw_batch([{'sql': 'SELECT 1'}], database_id='test-learning')
    assert client.is_closed and d1._READ_HTTP.get() is None


@pytest.mark.parametrize('fail_setup', [False, True])
def test_request_timing_includes_gcs_client_setup_even_when_it_fails(monkeypatch, caplog, fail_setup):
    from contextlib import nullcontext
    from routers import paired_nav
    tick = [0.0]
    monkeypatch.setattr(paired_nav, 'time', SimpleNamespace(monotonic=lambda: tick[0]))
    monkeypatch.setattr(d1, 'read_connection_scope', nullcontext)
    monkeypatch.setattr(paired_nav, 'client_for_domain', lambda domain: object())
    def store():
        tick[0] += 7.0
        if fail_setup:
            raise ValueError('private-gcs-identity')
        return object()
    def read(**kwargs):
        tick[0] += 2.0
        return {'status': 'original'}
    monkeypatch.setattr(paired_nav, 'production_read_store', store)
    monkeypatch.setattr(paired_nav, 'read_strategy_nav_read_model', read)
    if fail_setup:
        with pytest.raises(ValueError, match='private-gcs-identity'):
            paired_nav._read_strategy_display({}, None)
    else:
        assert paired_nav._read_strategy_display({}, None) == {'status': 'original'}
    message = next(r.message for r in caplog.records if '[StrategyNavRequest]' in r.message)
    assert 'setup_s=7.0000' in message
    assert ('display_s=0.0000' if fail_setup else 'display_s=2.0000') in message
    assert 'private' not in message
