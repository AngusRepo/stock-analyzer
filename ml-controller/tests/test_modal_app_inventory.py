import asyncio
from datetime import datetime, timedelta, timezone
import logging

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


def test_system_log_row_matches_worker_shape(monkeypatch):
    calls = []

    class Client:
        def execute(self, sql, params, timeout):
            calls.append((sql, params))
    from services import d1_domain_client
    monkeypatch.setattr(d1_domain_client, 'client_for_domain', lambda domain: calls.append(domain) or Client())
    inventory._write_system_log('warn', 'msg', {'k': 1})
    assert calls[0] == d1_domain_client.D1DataDomain.OPS
    assert 'INSERT INTO system_logs (level, cron_name, message, meta, created_at)' in calls[1][0]
    assert calls[1][1] == ['warn', 'modal-app-inventory', 'msg', '{"k": 1}']


def test_async_entry_skips_without_token_and_never_raises(monkeypatch, caplog):
    monkeypatch.delenv('MODAL_TOKEN_ID', raising=False)
    assert asyncio.run(inventory.run_inventory_alert()) == {'status': 'skipped', 'reason': 'modal_token_unset'}

    monkeypatch.setenv('MODAL_TOKEN_ID', 'TEST_ONLY')
    monkeypatch.setattr(inventory, 'list_modal_apps', lambda: (_ for _ in ()).throw(RuntimeError('auth')))

    async def host():
        await inventory.settle(asyncio.create_task(inventory.run_inventory_alert()))
        await inventory.settle(asyncio.create_task(asyncio.sleep(5)), timeout=0.01)
        return 'host_result'
    with caplog.at_level(logging.WARNING):
        assert asyncio.run(host()) == 'host_result'
    assert 'auth' in caplog.text


def test_preflight_runs_inventory_only_on_maintenance_ticks(monkeypatch):
    from routers import regime
    calls = []

    async def fake_inventory():
        calls.append('inventory')
        return {'status': 'ok'}

    async def fake_preflight(req):
        return {'maintenance': 'not_due', 'only': req.maintenance_only}
    monkeypatch.setattr(inventory, 'run_inventory_alert', fake_inventory)
    monkeypatch.setattr(regime, '_regime_preflight', fake_preflight)
    until = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    for only in (False, True):
        result = asyncio.run(regime.regime_preflight(regime.RegimePreflightRequest(
            required_until=until, maintenance_only=only)))
        assert result == {'maintenance': 'not_due', 'only': only}
    assert calls == ['inventory']
