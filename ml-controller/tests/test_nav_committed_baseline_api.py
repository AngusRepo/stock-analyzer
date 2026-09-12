"""Original ASGI/auth and original committed verifier; private query-only DB."""
import json
import os
import socket
import ipaddress
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from test_nav_l3_adoption import ready, publish
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment


def test_original_committed_api_auth_identity_no_caller_pass_and_no_writes(ready, monkeypatch):
    source, *_ = ready
    assert publish(ready)['readback_verified']
    conn = sqlite3.connect(':memory:', check_same_thread=False)
    conn.row_factory = sqlite3.Row
    source.conn.backup(conn)
    conn.execute('PRAGMA query_only=ON')
    def query(sql, params):
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    essentials = {'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'PYTHONPATH'}
    for key in tuple(os.environ):
        if key.upper() not in essentials:
            monkeypatch.delenv(key)
    monkeypatch.setenv('ML_CONTROLLER_SECRET', 'isolated-nav-test-token')
    monkeypatch.setenv('ENVIRONMENT', 'production')
    def forbidden(*args, **kwargs):
        raise AssertionError('nav_baseline_external_io_forbidden')
    original_connect = socket.socket.connect
    def local_connect(sock, address):
        try:
            local = isinstance(address, tuple) and ipaddress.ip_address(address[0]).is_loopback
        except ValueError:
            local = False
        if not local:
            forbidden()
        return original_connect(sock, address)
    monkeypatch.setattr(socket.socket, 'connect', local_connect)
    monkeypatch.setattr(socket, 'getaddrinfo', forbidden)
    import google.auth
    import grpc
    monkeypatch.setattr(google.auth, 'default', forbidden)
    for transport in (grpc, grpc.aio):
        monkeypatch.setattr(transport, 'secure_channel', forbidden)
        monkeypatch.setattr(transport, 'insecure_channel', forbidden)
    import main as controller
    from routers import paired_nav
    monkeypatch.setattr(controller, '_CONTROLLER_TOKEN', 'isolated-nav-test-token')
    monkeypatch.setattr(controller, '_ENVIRONMENT', 'production')
    monkeypatch.setattr(paired_nav, 'LEARNING_D1_CLIENT', SimpleNamespace(query=query))
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromisoformat('2026-09-22T14:00:00+00:00').astimezone(tz or timezone.utc)
    monkeypatch.setattr(paired_nav, 'datetime', Clock)
    formal = query('SELECT * FROM active8_ensemble_pointer_v1', [])[0]
    request = {key: formal[key] for key in ('artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum')}
    headers = {'X-Controller-Token': 'isolated-nav-test-token'}
    try:
        client = TestClient(controller.app)
        endpoint = '/nav/committed-l3-baseline'
        assert client.post(endpoint, json=request).status_code == 401
        assert client.post(endpoint, json=request, headers={'X-Controller-Token':'wrong'}).status_code == 401
        response = client.post(endpoint, json=request, headers=headers)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['source'] == 'original_committed_nav_publication'
        assert result['formal'] == request and result['read_only'] is True
        receipt = json.loads(result['receipt_json'])
        assert receipt['validation']['decision'] == 'FAIL'
        assert receipt['nav_validation']['decision'] == 'PASS'
        for extra in ({'decision':'PASS'}, {'now':'2099-01-01'}, {'anchors':[]}, {'sql':'SELECT 1'}):
            assert client.post(endpoint, json={**request, **extra}, headers=headers).status_code == 422
        assert client.post(endpoint, json={**request,'artifact_id':'wrong'}, headers=headers).status_code == 409
        assert conn.total_changes == 0
    finally:
        conn.close()


def test_original_bridge_ignores_unordered_result_permutation_not_changed_rows(ready):
    from services.active8_nav_baseline import read_committed_nav_baseline
    source, *_ = ready
    assert publish(ready)['readback_verified']
    formal = source.query('SELECT * FROM active8_ensemble_pointer_v1', [])[0]
    calls = {}
    def unordered(sql, params):
        rows = source.query(sql, params)
        calls[sql] = calls.get(sql, 0) + 1
        # Only unordered SELECT results may be permuted. PRAGMA index_info
        # reports index-column sequence; changing it changes the schema claim.
        return list(reversed(rows)) if sql.startswith('SELECT ') and 'ORDER BY' not in sql and calls[sql] % 2 else rows
    result = read_committed_nav_baseline(formal=formal, query=unordered,
        now=datetime.fromisoformat('2026-09-22T14:00:00+00:00'))
    assert result['formal']['artifact_id'] == formal['artifact_id']


@pytest.mark.parametrize('change', ['receipt', 'bytes', 'history', 'pointer', 'review', 'future'])
def test_original_bridge_rejects_corruption_without_new_review(ready, change):
    from services.active8_nav_baseline import read_committed_nav_baseline
    source, *_ = ready
    assert publish(ready)['readback_verified']
    formal = source.query('SELECT * FROM active8_ensemble_pointer_v1', [])[0]
    sql = {
        'receipt': "UPDATE active8_ensemble_pointer_v1 SET promotion_evidence_json='{}'",
        'bytes': "UPDATE active8_ensemble_artifacts_v1 SET payload_json='{}' WHERE state='production'",
        'history': 'DELETE FROM model_champion_history',
        'pointer': "UPDATE model_champion_pointers SET champion_version='changed'",
        'future': "UPDATE active8_ensemble_pointer_v1 SET promoted_at='2099-01-01 00:00:00'",
        'review': 'DROP TABLE paired_nav_review_parts_v1',
    }[change]
    source.conn.execute(sql)
    before = source.conn.total_changes
    with pytest.raises((RuntimeError, ValueError, KeyError, sqlite3.Error)):
        read_committed_nav_baseline(formal=formal, query=source.query,
            now=datetime.fromisoformat('2026-09-22T14:00:00+00:00'))
    assert source.conn.total_changes == before
