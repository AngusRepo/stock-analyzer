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
