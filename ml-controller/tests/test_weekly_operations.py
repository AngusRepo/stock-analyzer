import pytest
from services.weekly_operations import checkpoint


class MemoryReceipts:
    def __init__(self): self.values = {}
    def read(self, step): return self.values.get(step)
    def save(self, step, result): self.values[step] = result


@pytest.mark.asyncio
async def test_retry_reuses_completed_step_and_runs_unfinished_step():
    store = MemoryReceipts(); calls = []
    async def ic():
        calls.append('ic'); return {'status':'ok', 'n_rows_total':17}
    async def fail():
        calls.append('config'); raise RuntimeError('temporary downstream failure')
    async def config():
        calls.append('config_retry'); return {'status':'no_challenger'}
    fence = lambda: None
    await checkpoint(store, 'ic', ic, fence)
    with pytest.raises(RuntimeError): await checkpoint(store, 'config', fail, fence)
    await checkpoint(store, 'ic', ic, fence)
    await checkpoint(store, 'config', config, fence)
    assert calls == ['ic','config','config_retry']
    assert set(store.values) == {'ic','config'}


@pytest.mark.asyncio
async def test_failed_step_and_lost_owner_never_get_success_receipt():
    store = MemoryReceipts()
    async def failed(): return {'status':'error','error':'bad data'}
    with pytest.raises(RuntimeError, match='step_failed'):
        await checkpoint(store, 'ic', failed, lambda: None)
    def lost(): raise RuntimeError('lease_lost')
    with pytest.raises(RuntimeError, match='lease_lost'):
        await checkpoint(store, 'ic', failed, lost)
    assert store.values == {}


@pytest.mark.asyncio
async def test_audit_reuses_dated_archive_without_regenerating(monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from services import weekly_operations as ops
    @contextmanager
    def claim(*a, **kw): yield lambda: None
    store=MemoryReceipts()
    monkeypatch.setattr(ops,'replan_claim',claim)
    monkeypatch.setattr(ops,'StepReceipts',lambda *a:store)
    monkeypatch.setattr(ops,'client_for_domain',lambda _:SimpleNamespace(query=lambda sql,args:
        [{'report_date':args[0],'report_text':'original completed report'}]))
    result=await ops.run_weekly_operations('weekly-audit','2026-10-02')
    assert result['status']=='completed'
    assert result['audit']['source']=='existing_archive'
    assert result['audit']['report']=='original completed report'


@pytest.mark.asyncio
async def test_missing_historical_report_cannot_be_rebuilt_using_today(monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from services import weekly_operations as ops
    @contextmanager
    def claim(*a, **kw): yield lambda: None
    monkeypatch.setattr(ops,'replan_claim',claim)
    monkeypatch.setattr(ops,'StepReceipts',lambda *a:MemoryReceipts())
    monkeypatch.setattr(ops,'client_for_domain',lambda _:SimpleNamespace(query=lambda *a:[]))
    with pytest.raises(RuntimeError,match='historical_archive_missing'):
        await ops.run_weekly_operations('weekly-audit','2020-01-01')
