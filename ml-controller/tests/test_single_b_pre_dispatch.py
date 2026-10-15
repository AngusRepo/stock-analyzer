import asyncio
from types import SimpleNamespace
import pytest
from routers import walk_forward, pipeline
from services import single_b_daily_closure as closure, trading_config_loader, walk_forward_retrain

def test_verified_single_b_still_dispatches_forward_data_refresh(monkeypatch):
    from services import strategy_nav_read_model
    monkeypatch.setattr(strategy_nav_read_model,'strategy_nav_display_is_current',lambda **kw: True)
    monkeypatch.setattr(strategy_nav_read_model,'strategy_nav_daily_is_current',lambda **kw: {'status':'materialized'})
    result={'status':'native_l4_daily_accounted','completion_scope':'verified_formal_paper_plan',
        'native_l4_daily_closure':{'schema_version':'l4-daily-plan-closure-v1','signal_date':'2026-09-21',
            'plan_id':'a'*64,'model_checksum':'b'*64,'training_dispatched':False,'promoted':False},
        'paired_nav_maturity':{}, 'nav_retry_required':False}
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(closure,'single_b_daily_closure',lambda config,end:result)
    monkeypatch.delenv('OOF_MATERIALIZE_JOB_EXECUTION',raising=False)
    def dispatch_boundary():raise RuntimeError('reached_existing_durable_job_boundary')
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',dispatch_boundary)
    received=[]
    async def callback(payload):
        received.append(payload)
    monkeypatch.setattr(pipeline,'_callback_worker',callback)
    req=walk_forward.OofLifecycleRequest(cadence='daily',end_date='2026-09-21',scheduler_ticket_id='ticket',scheduler_run_id='run')
    with pytest.raises(RuntimeError,match='reached_existing_durable_job_boundary'):
        asyncio.run(walk_forward.run_walk_forward_oof_lifecycle(req))
    assert received==[]


@pytest.mark.parametrize('reason',['l4_daily_plan_missing','l4_daily_plan_pending_for_signal_date'])
def test_missing_morning_plan_cannot_skip_independent_data_job(monkeypatch, reason):
    result={'status':'blocked','expected_signal_date':'2026-10-02','reason':reason,
        'dependency_retry_required':False,'resume_after':'paper_plan_activation'}
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(closure,'single_b_daily_closure',lambda config,end:result)
    monkeypatch.delenv('OOF_MATERIALIZE_JOB_EXECUTION',raising=False)
    def dispatch_boundary():raise RuntimeError('reached_existing_durable_job_boundary')
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',dispatch_boundary)
    received=[]
    async def callback(payload):received.append(payload)
    monkeypatch.setattr(pipeline,'_callback_worker',callback)
    for attempt in (0,1,12,13):
        req=walk_forward.OofLifecycleRequest(cadence='daily',end_date='2026-10-02',
            scheduler_ticket_id='ticket',scheduler_run_id='run',continuation_attempt=attempt)
        with pytest.raises(RuntimeError,match='reached_existing_durable_job_boundary'):
            asyncio.run(walk_forward.run_walk_forward_oof_lifecycle(req))
    assert received==[]


def test_single_b_pending_plan_is_not_a_compute_retry(monkeypatch):
    from services import paper_strategy_mode, l4_oof_lifecycle, d1_domain_client
    monkeypatch.setattr(paper_strategy_mode,'single_b_policy',lambda *a,**k:{'mode':'single_b'})
    monkeypatch.setattr(paper_strategy_mode,'disabled_receipt',lambda *a,**k:{})
    monkeypatch.setattr(d1_domain_client,'client_proxy_for_domain',lambda *a:None)
    def pending(*a):raise l4_oof_lifecycle.L4DailyPlanPending('l4_daily_plan_pending_for_signal_date')
    monkeypatch.setattr(l4_oof_lifecycle,'daily_plan_closure',pending)
    result=closure.single_b_daily_closure({},'2026-10-02')
    assert result['status']=='blocked' and result['dependency_retry_required'] is False
    assert result['expected_signal_date']=='2026-10-02'


@pytest.mark.parametrize('probe_error',[False,True])
def test_missing_display_reaches_durable_dispatch_not_success_shortcut(monkeypatch, probe_error):
    from services import strategy_nav_read_model
    def probe(**kw):
        if probe_error: raise ValueError('display_unavailable')
        return False
    monkeypatch.setattr(strategy_nav_read_model,'strategy_nav_display_is_current',probe)
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(closure,'single_b_daily_closure',lambda *a:{
        'status':'native_l4_daily_accounted','native_l4_daily_closure':{'signal_date':'2026-09-21'}})
    monkeypatch.delenv('OOF_MATERIALIZE_JOB_EXECUTION',raising=False)
    async def forbidden(*a): raise AssertionError('missing display cannot close through shortcut')
    monkeypatch.setattr(pipeline,'_callback_worker',forbidden)
    def dispatch_boundary(): raise RuntimeError('reached_existing_durable_job_boundary')
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',dispatch_boundary)
    req=walk_forward.OofLifecycleRequest(cadence='daily',end_date='2026-09-21',
        scheduler_ticket_id='ticket',scheduler_run_id='run')
    with pytest.raises(RuntimeError,match='reached_existing_durable_job_boundary'):
        asyncio.run(walk_forward.run_walk_forward_oof_lifecycle(req))
