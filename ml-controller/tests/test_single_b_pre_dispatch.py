import asyncio
from types import SimpleNamespace
import pytest
from routers import walk_forward, pipeline
from services import single_b_daily_closure as closure, trading_config_loader, walk_forward_retrain

@pytest.mark.parametrize('callback_fails',[False, True])
def test_verified_single_b_skips_job_only_after_durable_callback(monkeypatch, callback_fails):
    result={'status':'native_l4_daily_accounted','completion_scope':'verified_formal_paper_plan',
        'native_l4_daily_closure':{'schema_version':'l4-daily-plan-closure-v1','signal_date':'2026-09-21',
            'plan_id':'a'*64,'model_checksum':'b'*64,'training_dispatched':False,'promoted':False},
        'paired_nav_maturity':{}, 'nav_retry_required':False}
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(closure,'single_b_daily_closure',lambda config,end:result)
    monkeypatch.delenv('OOF_MATERIALIZE_JOB_EXECUTION',raising=False)
    def forbidden():raise AssertionError('no GCS or Cloud Run job for completed daily Paper plan')
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',forbidden)
    received=[]
    async def callback(payload):
        received.append(payload)
        if callback_fails:raise RuntimeError('durable_callback_failed')
    monkeypatch.setattr(pipeline,'_callback_worker',callback)
    req=walk_forward.OofLifecycleRequest(cadence='daily',end_date='2026-09-21',scheduler_ticket_id='ticket',scheduler_run_id='run')
    if callback_fails:
        with pytest.raises(RuntimeError,match='durable_callback_failed'):
            asyncio.run(walk_forward.run_walk_forward_oof_lifecycle(req))
    else:
        actual=asyncio.run(walk_forward.run_walk_forward_oof_lifecycle(req))
        assert actual['job_dispatched'] is False and actual['callback_delivered'] is True
        assert actual['status']=='pending' # dispatch never owns terminal closure
    assert received[0]['scheduler_ticket_id']=='ticket'
    assert received[0]['metadata']['native_l4_daily_closure']==result['native_l4_daily_closure']
    assert 'oof_freshness' not in received[0]['metadata']


@pytest.mark.parametrize('reason',['l4_daily_plan_missing','l4_daily_plan_pending_for_signal_date'])
def test_missing_morning_plan_closes_ticket_without_job_or_continuation(monkeypatch, reason):
    result={'status':'blocked','expected_signal_date':'2026-10-02','reason':reason,
        'dependency_retry_required':False,'resume_after':'paper_plan_activation'}
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(closure,'single_b_daily_closure',lambda config,end:result)
    monkeypatch.delenv('OOF_MATERIALIZE_JOB_EXECUTION',raising=False)
    def forbidden():raise AssertionError('missing morning plan must never launch a job')
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',forbidden)
    received=[]
    async def callback(payload):received.append(payload)
    monkeypatch.setattr(pipeline,'_callback_worker',callback)
    for attempt in (0,1,12,13):
        req=walk_forward.OofLifecycleRequest(cadence='daily',end_date='2026-10-02',
            scheduler_ticket_id='ticket',scheduler_run_id='run',continuation_attempt=attempt)
        actual=asyncio.run(walk_forward.run_walk_forward_oof_lifecycle(req))
        assert actual['status']=='blocked' and actual['job_dispatched'] is False
    assert all(p['status']=='error' and p['scheduler_ticket_id']=='ticket' for p in received)
    assert all(p['metadata']['dependency_retry_required'] is False for p in received)


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
