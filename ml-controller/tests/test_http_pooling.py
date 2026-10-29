"""PERF-D4: idempotent D1/KV reads share one keep-alive client; writes keep a fresh connection."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import d1_client, kv_client  # noqa: E402


@pytest.fixture()
def wire(monkeypatch):
    seen = {'pooled': [], 'fresh': []}

    def handler(request):
        seen['pooled'].append(request.url.path)
        if '/values/' in request.url.path:
            return httpx.Response(200, text='"v"')
        return httpx.Response(200, json={'success': True, 'result': [{'results': [{'ok': 1}], 'meta': {'changes': 1}}]})

    def fresh_post(url, **kwargs):
        seen['fresh'].append(kwargs['json']['sql'])
        return httpx.Response(200, json={'success': True, 'result': [{'results': [], 'meta': {'changes': 1}}]},
                              request=httpx.Request('POST', url))

    pooled = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(d1_client, '_POOLED_HTTP', {os.getpid(): pooled})
    monkeypatch.setattr(d1_client.httpx, 'post', fresh_post)
    for module, names in ((d1_client, ('CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_D1_DB_ID')),
                          (kv_client, ('CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID'))):
        for name in names:
            monkeypatch.setattr(module, name, 'x')
    monkeypatch.setattr(d1_client, 'allocator_contract_guard_enabled', lambda: False)
    yield seen
    pooled.close()


def test_reads_use_pooled_client_and_writes_do_not(wire):
    assert d1_client.query('SELECT 1 AS ok') == [{'ok': 1}]
    assert d1_client.query('WITH a AS (SELECT 1) SELECT * FROM a') == [{'ok': 1}]
    d1_client.execute('UPDATE t SET a=1')
    d1_client.query('WITH a AS (SELECT 1) DELETE FROM t RETURNING *')
    d1_client.query('INSERT INTO t VALUES (1) RETURNING *')
    assert kv_client._get_remote('k') == '"v"'
    assert len(wire['pooled']) == 3 and wire['pooled'][-1].endswith('/values/k')
    assert wire['fresh'] == ['UPDATE t SET a=1', 'WITH a AS (SELECT 1) DELETE FROM t RETURNING *',
                             'INSERT INTO t VALUES (1) RETURNING *']


def test_pool_is_per_process_and_skipped_for_stubbed_httpx(monkeypatch):
    monkeypatch.setattr(d1_client, '_POOLED_HTTP', {})
    first = d1_client.pooled_http_client()
    try:
        assert d1_client.pooled_http_client() is first
        monkeypatch.setattr(d1_client.os, 'getpid', lambda: -1)
        assert d1_client.pooled_http_client() is not first
        assert d1_client.pooled_http_client(object()) is None
    finally:
        for client in d1_client._POOLED_HTTP.values():
            client.close()


def test_kv_read_retries_once_on_a_stale_pooled_connection(wire, monkeypatch):
    def stale(request):
        raise httpx.RemoteProtocolError('Server disconnected without sending a response.', request=request)
    monkeypatch.setattr(d1_client, '_POOLED_HTTP', {os.getpid(): httpx.Client(transport=httpx.MockTransport(stale))})
    fresh = []
    monkeypatch.setattr(kv_client.httpx, 'get', lambda url, **kw: fresh.append(url) or httpx.Response(200, text='"v"'))
    assert kv_client._get_remote('k') == '"v"'
    assert len(fresh) == 1 and fresh[0].endswith('/values/k')
