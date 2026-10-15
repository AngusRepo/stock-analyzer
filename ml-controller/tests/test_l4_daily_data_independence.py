import asyncio
from datetime import datetime, timezone
import hashlib,json
from types import SimpleNamespace

import pytest
import oof_materialize_job_main as job
from services import l4_forward_refresh as refresh, trading_config_loader


@pytest.mark.parametrize('account_status', ['blocked', 'native_l4_daily_accounted', 'exception'])
def test_data_runs_independently_of_account_closure_and_keeps_its_evidence(monkeypatch, account_status):
    events=[]
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    def data(config,day):
        events.append('data')
        assert day=='2026-10-14'
        return {'status':'refreshed','latest_training_eligible_date':'2026-10-07'}
    async def account(**kwargs):
        events.append('account')
        if account_status=='exception':raise ValueError('account failure')
        return {'status':account_status,'dependency_retry_required':False}
    monkeypatch.setattr(refresh,'refresh_daily',data)
    monkeypatch.setattr(job,'_execute_account_lifecycle',account)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-10-14'))
    assert sorted(events)==['account','data']
    assert result['status']==('failed' if account_status=='exception' else account_status)
    assert result['forward_learning_data']['latest_training_eligible_date']=='2026-10-07'


def test_slow_full_pool_observation_cannot_block_account_closure(monkeypatch):
    import threading
    started=threading.Event();closed=threading.Event()
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    def data(*args):
        started.set()
        assert closed.wait(2),'account must close while observation is running'
        return {'status':'refreshed'}
    async def account(**kwargs):
        assert await asyncio.to_thread(started.wait,2)
        closed.set()
        return {'status':'native_l4_daily_accounted'}
    monkeypatch.setattr(refresh,'refresh_daily',data)
    monkeypatch.setattr(job,'_execute_account_lifecycle',account)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-10-14'))
    assert result['forward_learning_data']['status']=='refreshed'


def test_data_failure_does_not_skip_healthy_account_or_turn_green(monkeypatch):
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    def data(*args):raise ValueError('l4_forward_daily_price_source_missing')
    async def account(**kwargs):return {'status':'native_l4_daily_accounted','closure':'verified'}
    monkeypatch.setattr(refresh,'refresh_daily',data)
    monkeypatch.setattr(job,'_execute_account_lifecycle',account)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-10-14'))
    assert result['status']=='failed' and result['closure']=='verified'
    assert result['accounting_status']=='native_l4_daily_accounted'


def test_missing_plan_refreshes_labels_but_cannot_adopt_or_publish_strategy(monkeypatch):
    from services import single_b_daily_closure
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(refresh,'refresh_daily',lambda *a:{'status':'refreshed'})
    monkeypatch.setattr(single_b_daily_closure,'single_b_daily_closure',lambda *a:{'status':'blocked','reason':'plan_missing'})
    def forbidden(**kwargs):raise AssertionError('blocked account must not run NAV/adoption/publication')
    monkeypatch.setattr(job,'_execute_daily_nav',forbidden)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-10-14',
        promote=True,dispatch_full_fit=False,expected_cohort_id=None,continuation_attempt=0,continuation_only=False))
    assert result['status']=='blocked' and result['reason']=='plan_missing'
    assert result['forward_learning_data']['status']=='refreshed'


class Blob:
    def __init__(self,name,raw,hour):
        self.name,self.raw=name,raw
        self.generation=1
        self.time_created=datetime(2026,10,14,hour,tzinfo=timezone.utc)
    def download_as_bytes(self,**kwargs):return self.raw


def test_downstream_failure_preserves_independent_maturity_dates():
    result={'status':'refreshed','latest_training_eligible_date':'2026-10-07','r2_shadow':{'status':'sealed'}}
    refresh.component_failure(result,'r2_paired',ValueError('l4_r2_pair_parent_changed'))
    assert result['status']=='failed' and result['reason']=='l4_r2_pair_parent_changed'
    assert result['latest_training_eligible_date']=='2026-10-07' and result['r2_shadow']['status']=='sealed'


@pytest.mark.parametrize('account_status',['native_l4_daily_accounted','failed','blocked'])
def test_pending_inference_never_turns_green_or_masks_account_failure(monkeypatch,account_status):
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(refresh,'refresh_daily',lambda *a:{'status':'pending','external_compute_pending':True})
    async def account(**kwargs):return {'status':account_status}
    monkeypatch.setattr(job,'_execute_account_lifecycle',account)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-10-15'))
    assert result['status']==('pending' if account_status=='native_l4_daily_accounted' else account_status)
    assert result['dependency_retry_required'] is True
    if result['status']=='pending':assert result['external_compute_pending'] is True


def test_newest_price_receipt_has_no_plan_dependency_or_silent_corrupt_fallback():
    manifest=json.dumps({'end_date':'2026-10-14'}).encode()
    blobs={}
    for label,hour in [('old',12),('new',13),('future',16)]:
        prefix='universal/oof_forward_prep_v2/2026-10-14-'+label
        receipt=dict(status='ready',business_date='2026-10-14',output_gcs_prefix=prefix,
            price_capture={'capture_manifest_path':'prices/'+label,'capture_manifest_sha256':hashlib.sha256(manifest).hexdigest()})
        receipt['receipt_checksum']=hashlib.sha256(json.dumps(receipt,sort_keys=True).encode()).hexdigest()
        name=prefix+'/prep/immutable_receipt.json'
        blobs[name]=Blob(name,json.dumps(receipt).encode(),hour)
        blobs['prices/'+label]=Blob('prices/'+label,manifest,hour)
    bucket=SimpleNamespace(list_blobs=lambda prefix:[b for n,b in blobs.items() if n.startswith(prefix)],
                           blob=lambda name:blobs[name])
    selected,proof=refresh.current_price_capture(bucket,'2026-10-14',cutoff='2026-10-14T15:00:00+00:00')
    assert selected['capture_manifest_path']=='prices/new'
    blobs[proof['path']].raw=b'{}'
    with pytest.raises(ValueError,match='daily_price_receipt_invalid'):
        refresh.current_price_capture(bucket,'2026-10-14',cutoff='2026-10-14T15:00:00+00:00')
