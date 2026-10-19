"""Daily entrypoint preserves shadow progress despite Paper branch outcomes."""
import asyncio
import importlib.util
from types import SimpleNamespace
import pytest
from test_l4_r17_native import SOURCE


@pytest.mark.parametrize('pending',[False,True])
def test_job_preserves_r17_registration_and_existing_compute_continuation(monkeypatch,pending):
    spec=importlib.util.spec_from_file_location('r17_job_test',SOURCE/'oof_materialize_job_main.py')
    job=importlib.util.module_from_spec(spec);spec.loader.exec_module(job)
    monkeypatch.setattr('services.trading_config_loader.load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    shadow={'status':'pending' if pending else 'ok','registration':{'status':'pending' if pending else 'registered'},
        'maturity':{'acceptance':{'count':0}}}
    data={'status':'pending' if pending else 'ok','forward_learning_data':{'status':'ok'},
        'r17_p4':shadow,'external_compute_pending':pending}
    monkeypatch.setattr('services.l4_forward_refresh.attach_daily_result',lambda *args:data)
    async def account(**kwargs):return {'status':'native_l4_daily_accounted','native_l4_daily_closure':{'receipt':'original'}}
    monkeypatch.setattr(job,'_execute_account_lifecycle',account)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-10-20'))
    assert result['r17_p4']==shadow
    assert result['native_l4_daily_closure']=={'receipt':'original'}
    if pending:assert result['external_compute_pending'] and result['dependency_retry_required']
    else:assert result['status']=='native_l4_daily_accounted'


def test_job_keeps_r17_result_when_account_branch_fails(monkeypatch):
    spec=importlib.util.spec_from_file_location('r17_job_failure_test',SOURCE/'oof_materialize_job_main.py')
    job=importlib.util.module_from_spec(spec);spec.loader.exec_module(job)
    monkeypatch.setattr('services.trading_config_loader.load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    shadow={'status':'ok','registration':{'status':'registered'}}
    monkeypatch.setattr('services.l4_forward_refresh.attach_daily_result',lambda *args:{
        'status':'ok','forward_learning_data':{},'r17_p4':shadow})
    async def account(**kwargs):raise ValueError('account branch unavailable')
    monkeypatch.setattr(job,'_execute_account_lifecycle',account)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-10-20'))
    assert result['status']=='failed' and result['r17_p4']==shadow
