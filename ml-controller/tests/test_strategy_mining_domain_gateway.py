import httpx
import pytest

from services import d1_client, d1_domain_client


@pytest.fixture
def gateway(monkeypatch):
    monkeypatch.setattr(d1_client, 'STRATEGY_MINING_D1_WORKER_ONLY', True)
    monkeypatch.setattr(d1_client, 'WORKER_URL', 'https://worker.test')
    monkeypatch.setattr(d1_client, 'WORKER_AUTH', 'test-dedicated-token')
    monkeypatch.setattr(d1_client, 'CF_D1_DB_ID', '')
    monkeypatch.delenv('CF_D1_DB_ID', raising=False)
    monkeypatch.delenv('MULTI_D1_ACTIVE_DOMAINS', raising=False)
    def forbidden(*args, **kwargs):
        raise AssertionError('direct database transport must not be used')
    monkeypatch.setattr(d1_client, '_post', forbidden)
    monkeypatch.setattr(d1_client, '_raw_batch_execute', forbidden)
    calls = []
    def post(url, *, json, **kwargs):
        assert url.endswith('/api/internal/strategy-mining/d1')
        assert kwargs['headers']['Authorization'] == 'Bearer test-dedicated-token'
        calls.append(json)
        count = len(json['statements'])
        assert count <= 100
        return httpx.Response(200, json={
            'ok': True, 'total': count, 'success_count': count, 'error_count': 0,
            'results': [{'success': True, 'results': [{'run_id': 'r'}], 'meta': {'changes': 1}}] * count,
        })
    monkeypatch.setattr(d1_client.httpx, 'post', post)
    return d1_domain_client.client_for_domain('research'), calls


def test_domain_query_and_first_ledger_insert_need_no_direct_credentials(gateway):
    client, calls = gateway
    assert client.query('SELECT run_id FROM strategy_mining_runs') == [{'run_id': 'r'}]
    assert client.execute('INSERT INTO strategy_mining_runs(run_id) VALUES (?)', ['r'])['success']
    assert len(calls) == 2


def test_default_250_batch_respects_gateway_100_statement_limit(gateway):
    client, calls = gateway
    result = client.batch_execute([('UPDATE strategy_mining_runs SET status=?', ['done'])] * 251)
    assert result['success_count'] == 251
    assert [len(c['statements']) for c in calls] == [100, 100, 51]


def test_atomic_gateway_batch_is_never_split(gateway):
    client, calls = gateway
    assert client.atomic_batch_execute([('UPDATE strategy_mining_runs SET status=?', ['done'])])['atomic']
    with pytest.raises(RuntimeError, match='exceeds 100'):
        client.atomic_batch_execute([('UPDATE strategy_mining_runs SET status=?', ['done'])] * 101)
    assert len(calls) == 1


def test_other_domains_fail_closed(gateway):
    for domain in ('ops', 'learning', 'core', 'execution'):
        with pytest.raises(RuntimeError, match='cannot access domain'):
            d1_domain_client.client_for_domain(domain).query('SELECT 1')


def test_incomplete_ack_never_falls_back_to_broad_credentials(gateway, monkeypatch):
    client, _ = gateway
    monkeypatch.setattr(d1_client.httpx, 'post', lambda *a, **kw: httpx.Response(200, json={'ok': True}))
    with pytest.raises(d1_client.D1DurableBatchRetryRequired, match='incomplete batch acknowledgement'):
        client.batch_execute([('UPDATE strategy_mining_runs SET status=?', ['done'])])
    with pytest.raises(RuntimeError, match='invalid response'):
        client.query('SELECT run_id FROM strategy_mining_runs')
