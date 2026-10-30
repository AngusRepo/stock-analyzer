import asyncio
from datetime import datetime, timedelta, timezone
import logging
import time

import pytest

from services import modal_app_inventory as inventory

NOW = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)


def app(app_id, name, state, hours, tasks=0):
    return {'app_id': app_id, 'name': name, 'state': state,
            'created_at': (NOW - timedelta(hours=hours)).timestamp(), 'tasks': tasks}


APPS = [
    app('ap-deployed', 'stockvision-ml', 'deployed', 24 * 100),
    app('ap-repair', 'stockvision-inference-repair-20261013-a', 'detached', 24 * 16, tasks=1),
    app('ap-reuse', 'stockvision-ml', 'ephemeral', 2, tasks=3),
    app('ap-fresh', 'adhoc-holding-inspect-20261030', 'detached_disconnected', 3),
    app('ap-stopped', 'adhoc-old-20261001', 'stopped', 24 * 29),
]


def test_flags_old_ephemeral_and_deployed_name_reuse_only():
    flagged = {row['app_id']: row for row in inventory.evaluate_apps(APPS, NOW)}
    assert set(flagged) == {'ap-repair', 'ap-reuse'}
    assert flagged['ap-repair'] == {
        'app_id': 'ap-repair', 'name': 'stockvision-inference-repair-20261013-a', 'state': 'detached',
        'age_hours': 384.0, 'created_at': (NOW - timedelta(hours=384)).isoformat(), 'tasks': 1,
        'reasons': ['alive_over_24h']}
    assert flagged['ap-reuse']['reasons'] == ['deployed_name_reuse']


def test_boundary_and_unknown_creation_time():
    apps = [app('ap-24', 'adhoc-a-20261029', 'ephemeral', 24), app('ap-25', 'adhoc-b-20261029', 'detached', 24.1),
            {**app('ap-x', 'adhoc-c-20261029', 'detached', 1), 'created_at': 0}]
    assert {row['app_id']: row['reasons'] for row in inventory.evaluate_apps(apps, NOW)} == {
        'ap-25': ['alive_over_24h'], 'ap-x': ['alive_over_24h']}


def test_alert_writes_one_ops_system_log_warn(caplog):
    writes = []
    with caplog.at_level(logging.WARNING):
        summary = inventory.run_inventory(lister=lambda: APPS, log_writer=lambda *row: writes.append(row), now=NOW)
    assert summary['status'] == 'alert' and summary['apps'] == 5 and len(summary['flagged']) == 2
    assert len(writes) == 1 and writes[0][0] == 'warn' and writes[0][2] == summary
    assert 'ap-repair' in writes[0][1] and 'ap-repair' in caplog.text


def test_clean_inventory_writes_nothing_and_failed_log_keeps_warning(caplog):
    assert inventory.run_inventory(lister=lambda: APPS[:1], log_writer=lambda *_: 1 / 0, now=NOW) == {
        'status': 'ok', 'apps': 1, 'flagged': []}

    def broken(*_):
        raise RuntimeError('d1 down')
    with caplog.at_level(logging.WARNING):
        assert inventory.run_inventory(lister=lambda: APPS, log_writer=broken, now=NOW)['status'] == 'alert'
    assert 'system_logs write failed' in caplog.text and 'need a stop' in caplog.text


def test_unknown_app_state_does_not_fail_the_inventory():
    from modal_proto import api_pb2
    assert inventory.state_name(api_pb2.AppState, api_pb2.APP_STATE_DETACHED_DISCONNECTED) == 'detached_disconnected'
    assert inventory.state_name(api_pb2.AppState, 999) == 'unknown_999'
    assert inventory.evaluate_apps([app('ap-new', 'x', 'unknown_999', 99)], NOW) == []


def test_system_log_is_one_unretried_ops_insert(monkeypatch):
    import httpx
    from services import d1_client, d1_domain_client
    calls = []

    class Response:
        status_code = 503

        def json(self):
            return {'success': False}
    monkeypatch.setattr(d1_client, 'CF_ACCOUNT_ID', 'TEST_ACCOUNT')
    monkeypatch.setattr(d1_client, 'CF_API_TOKEN', 'TEST_ONLY')
    monkeypatch.setattr(d1_domain_client, 'database_id_for_domain', lambda domain: f'db-{domain.value}')
    monkeypatch.setattr(httpx, 'post', lambda url, **kw: calls.append((url, kw['json'])) or Response())
    with pytest.raises(RuntimeError, match='HTTP 503'):
        inventory._write_system_log('warn', 'msg', {'k': 1})
    assert len(calls) == 1 and calls[0][0].endswith('/d1/database/db-ops/query')
    assert 'INSERT INTO system_logs (level, cron_name, message, meta, created_at)' in calls[0][1]['sql']
    assert calls[0][1]['params'] == ['warn', 'modal-app-inventory', 'msg', '{"k": 1}']


def test_async_entry_skips_without_token_and_background_never_raises(monkeypatch, caplog):
    monkeypatch.delenv('MODAL_TOKEN_ID', raising=False)
    assert asyncio.run(inventory.run_inventory_alert()) == {'status': 'skipped', 'reason': 'modal_token_unset'}

    monkeypatch.setenv('MODAL_TOKEN_ID', 'TEST_ONLY')
    monkeypatch.setattr(inventory, 'list_modal_apps', lambda: (_ for _ in ()).throw(RuntimeError('auth')))
    with caplog.at_level(logging.WARNING):
        assert asyncio.run(inventory._bounded_inventory()) == {'status': 'failed', 'error': 'RuntimeError'}
    assert 'auth' in caplog.text


def test_background_task_is_bounded_kept_and_single(monkeypatch):
    async def slow():
        await asyncio.sleep(60)
    monkeypatch.setattr(inventory, 'run_inventory_alert', slow)
    monkeypatch.setattr(inventory, 'INVENTORY_TIMEOUT_SEC', 0.05)

    async def host():
        task = inventory.start_background()
        assert task in inventory._BACKGROUND and inventory.start_background() is None
        result = await task
        await asyncio.sleep(0)
        return result, set(inventory._BACKGROUND)
    assert asyncio.run(host()) == ({'status': 'failed', 'error': 'TimeoutError'}, set())


def test_preflight_response_never_waits_for_inventory(monkeypatch):
    from routers import regime
    calls = []

    async def slow_inventory():
        calls.append('inventory')
        await asyncio.sleep(30)

    async def fake_preflight(req):
        return {'maintenance': 'not_due', 'only': req.maintenance_only}
    monkeypatch.setattr(inventory, 'run_inventory_alert', slow_inventory)
    monkeypatch.setattr(regime, '_regime_preflight', fake_preflight)
    until = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()

    async def call(only):
        started = time.monotonic()
        result = await regime.regime_preflight(regime.RegimePreflightRequest(
            required_until=until, maintenance_only=only))
        elapsed = time.monotonic() - started
        await asyncio.sleep(0.01)  # let the background task start
        pending = set(inventory._BACKGROUND)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        return result, elapsed, len(pending)
    for only, started in ((False, 0), (True, 1)):
        result, elapsed, pending = asyncio.run(call(only))
        assert result == {'maintenance': 'not_due', 'only': only}
        assert elapsed < 0.5 and pending == started
    assert calls == ['inventory']


def test_admin_view_skips_without_token_and_times_out(monkeypatch):
    from fastapi import HTTPException
    from routers import admin
    monkeypatch.delenv('MODAL_TOKEN_ID', raising=False)
    assert asyncio.run(admin.modal_app_inventory_view()) == {'status': 'skipped', 'reason': 'modal_token_unset'}

    monkeypatch.setenv('MODAL_TOKEN_ID', 'TEST_ONLY')
    monkeypatch.setattr(inventory, 'list_modal_apps', lambda: APPS)
    view = asyncio.run(admin.modal_app_inventory_view())
    assert view['status'] == 'ok' and view['apps'] == 5 and {a['app_id'] for a in view['flagged']} == {
        'ap-repair', 'ap-reuse'}

    monkeypatch.setattr(inventory, 'INVENTORY_TIMEOUT_SEC', 0.05)
    monkeypatch.setattr(inventory, 'list_modal_apps', lambda: time.sleep(0.3) or APPS)
    with pytest.raises(HTTPException) as err:
        asyncio.run(admin.modal_app_inventory_view())
    assert err.value.status_code == 504
