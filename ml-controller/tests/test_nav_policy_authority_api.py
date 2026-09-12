"""Full original Controller ASGI app/auth -> original policy/NAV, private SQLite.

External sockets, Google ADC and gRPC are denied; this never dispatches cloud work.
Requires the Controller's declared runtime dependencies, not a reconstructed app.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import subprocess
import socket
import ipaddress
from types import SimpleNamespace
import pytest

from fastapi.testclient import TestClient

from services.paired_nav_route_candidate import collect_route_allocations
from services.paired_nav_policy_daily import refresh_registered_route_nav_decisions
from test_paired_nav_route_pit import prepared, environment, with_routes, route_freeze_clock
from test_paired_nav_review_store import migrate


def test_policy_api_rereads_original_owner_and_rejects_caller_verdict(prepared, route_freeze_clock, monkeypatch, tmp_path):
    db, frozen = with_routes(prepared)
    migrate(db)
    collect_route_allocations(snapshot_id=frozen['snapshot_id'], query=db.query, writer=db.writer)
    clock = datetime.fromisoformat('2026-09-07T14:00:00+00:00')
    candidates = []
    refresh_registered_route_nav_decisions(business_date='2026-09-07', query=db.query,
        now=clock, adoption_candidates=candidates)
    payload = candidates[0]['payload']
    db.conn.commit()
    # Preserve every original row; the HTTP handler executes in its own thread.
    conn = sqlite3.connect(':memory:', check_same_thread=False)
    conn.row_factory = sqlite3.Row
    db.conn.backup(conn)
    conn.execute('PRAGMA query_only=ON')
    def query(sql, params):
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    from routers import paired_nav
    # Load the actual complete entrypoint. No AST-extracted auth/mount and no
    # replacement app or dependency override. Keep process essentials but never
    # inherit service credentials into the imported app or the child Worker test.
    essentials = {'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'PYTHONPATH'}
    for key in tuple(os.environ):
        if key.upper() not in essentials:
            monkeypatch.delenv(key)
    monkeypatch.setenv('ML_CONTROLLER_SECRET', 'isolated-nav-test-token')
    monkeypatch.setenv('ENVIRONMENT', 'production')
    def forbidden(*args, **kwargs):
        raise AssertionError('nav_full_app_external_io_forbidden')
    original_connect = socket.socket.connect
    def loopback_connect(sock, address):
        # Windows asyncio builds its wake-up socketpair over literal loopback.
        # This is local IPC, not authorization for DNS or external connections.
        try:
            local = isinstance(address, tuple) and ipaddress.ip_address(address[0]).is_loopback
        except ValueError:
            local = False
        if not local:
            forbidden()
        return original_connect(sock, address)
    monkeypatch.setattr(socket.socket, 'connect', loopback_connect)
    monkeypatch.setattr(socket, 'getaddrinfo', forbidden)
    with socket.socket() as probe, pytest.raises(AssertionError, match='external_io_forbidden'):
        probe.connect(('203.0.113.1', 443))
    import google.auth
    import grpc
    monkeypatch.setattr(google.auth, 'default', forbidden)
    for transport in (grpc, grpc.aio):
        monkeypatch.setattr(transport, 'secure_channel', forbidden)
        monkeypatch.setattr(transport, 'insecure_channel', forbidden)
    import main as controller
    # Globals can be cached by another complete-app test. Configure the real
    # verifier, never override the verifier itself or its Depends registrations.
    monkeypatch.setattr(controller, '_CONTROLLER_TOKEN', 'isolated-nav-test-token')
    monkeypatch.setattr(controller, '_ENVIRONMENT', 'production')
    app = controller.app
    assert app.title == 'StockVision ML Controller'
    monkeypatch.setattr(paired_nav, 'LEARNING_D1_CLIENT', SimpleNamespace(query=query))
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.astimezone(tz or timezone.utc)
    monkeypatch.setattr(paired_nav, 'datetime', Clock)
    request = {'owner': 'l15_route', 'candidate_artifact_id': payload['artifact_id'],
        'candidate_checksum': payload['artifact_checksum'], 'business_date': '2026-09-07'}
    headers = {'X-Controller-Token': 'isolated-nav-test-token'}
    try:
        client = TestClient(app)
        strategy_request = {'strategy_id': 'no-atomic-candidate', 'strategy_version': 'v1', 'business_date': '2026-09-07'}
        assert client.post('/nav/strategy-evidence', json=strategy_request).status_code == 401
        assert client.post('/nav/strategy-evidence', json=strategy_request,
            headers={'X-Controller-Token': 'wrong-token'}).status_code == 401
        assert client.post('/nav/strategy-evidence', json={**strategy_request, 'decision': 'PASS'}, headers=headers).status_code == 422
        strategy_response = client.post('/nav/strategy-evidence', json=strategy_request, headers=headers)
        assert strategy_response.status_code == 200, strategy_response.text
        assert strategy_response.json()['status'] == 'not_registered'
        assert strategy_response.json()['promotion_allowed'] is False
        assert client.post('/nav/policy-decision', json=request).status_code == 401
        assert client.post('/nav/policy-decision', json=request,
            headers={'X-Controller-Token': 'wrong-token'}).status_code == 401
        # Startup/config mistakes cannot silently enter the development bypass.
        with monkeypatch.context() as missing_secret:
            missing_secret.setattr(controller, '_CONTROLLER_TOKEN', '')
            assert client.post('/nav/policy-decision', json=request, headers=headers).status_code == 500
        response = client.post('/nav/policy-decision', json=request, headers=headers)
        assert response.status_code == 200, response.text
        actual = response.json()
        assert actual['payload'] == payload
        assert actual['payload']['prospective_validation']['decision'] == 'PENDING'
        assert actual['read_only'] is True
        assert actual['source'] == 'original_frozen_policy_and_verified_nav'
        fixture = tmp_path / 'original-policy-authority.json'
        fixture.write_text(json.dumps(actual, ensure_ascii=False), encoding='utf-8')
        child_env = {**os.environ, 'NAV_POLICY_AUTHORITY_FIXTURE': str(fixture)}
        child_env.pop('NODE_TEST_CONTEXT', None)
        worker = subprocess.run(['node', '--import', 'tsx', '--test', '--test-reporter=tap',
            'tests/navPolicyAuthority.ts'], cwd=Path(__file__).parents[2] / 'worker',
            env=child_env, capture_output=True, text=True, encoding='utf-8', timeout=60)
        assert worker.returncode == 0, worker.stdout + worker.stderr
        assert '# pass 4' in worker.stdout and '# fail 0' in worker.stdout
        for extra in ({'decision': 'PASS'}, {'policy_definition': {}}, {'now': clock.isoformat()},
                      {'nav_validation': {'decision': 'PASS', 'evaluable_date_count': 30}}):
            assert client.post('/nav/policy-decision', json={**request, **extra}, headers=headers).status_code == 422
        assert client.post('/nav/policy-decision', json={**request, 'owner': 'ensemble'}, headers=headers).status_code == 422
        wrong = client.post('/nav/policy-decision', json={**request, 'candidate_artifact_id': 'wrong'}, headers=headers)
        assert wrong.status_code == 409 and wrong.json()['detail'] == 'nav_policy_requested_identity_missing'
        future = client.post('/nav/policy-decision', json={**request, 'business_date': '2026-09-08'}, headers=headers)
        assert future.status_code == 409 and future.json()['detail'] == 'nav_policy_daily_time_invalid'
        assert conn.total_changes == 0
    finally:
        conn.close()
