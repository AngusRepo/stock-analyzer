import asyncio
from types import SimpleNamespace
import pytest
from services.training_dual_cutoff import request_cutoff_from_environment

CUTOFF={'signal_date_max':'2026-09-22','label_known_at_max':'2026-10-01'}
ENV={'OOF_MATERIALIZE_SIGNAL_DATE_MAX':'2026-09-22',
     'OOF_MATERIALIZE_LABEL_KNOWN_AT_MAX':'2026-10-01','OOF_MATERIALIZE_END_DATE':'2026-10-01'}


def test_invalid_or_partial_cutoff_cannot_silently_become_unbounded():
    assert request_cutoff_from_environment({})=={}
    assert request_cutoff_from_environment(ENV)==CUTOFF
    for patch in ({'OOF_MATERIALIZE_SIGNAL_DATE_MAX':''},
                  {'OOF_MATERIALIZE_LABEL_KNOWN_AT_MAX':''},
                  {'OOF_MATERIALIZE_END_DATE':'2026-10-19'}):
        with pytest.raises(ValueError):request_cutoff_from_environment({**ENV,**patch})


def test_real_api_to_job_to_lifecycle_preserves_both_cutoffs(monkeypatch):
    from routers import walk_forward as route
    from services import cloud_run_jobs_client, walk_forward_retrain, trading_config_loader
    import oof_materialize_job_main as job
    calls=[]
    class Jobs:
        def __init__(self,**kwargs):pass
        def run_job(self,**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(execution_id='execution',execution_name='jobs/test/executions/execution')
    monkeypatch.setattr(cloud_run_jobs_client,'CloudRunJobsClient',Jobs)
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',lambda:object())
    monkeypatch.setattr(route,'_pre_dispatch_completed_oof_lifecycle',lambda *args,**kw:None)
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={}))
    monkeypatch.delenv('OOF_MATERIALIZE_JOB_EXECUTION',raising=False)
    result=asyncio.run(route.run_walk_forward_oof_lifecycle(route.OofLifecycleRequest(
        cadence='monthly',promote=False,**CUTOFF)))
    assert result['status']=='spawned' and len(calls)==1
    env=calls[0]['env_overrides']
    assert request_cutoff_from_environment(env)==CUTOFF
    assert env['OOF_MATERIALIZE_PROMOTE']=='0'
    for key,value in env.items():monkeypatch.setenv(key,value)
    received=[]
    async def run(req):received.append(req);return {'status':'pending'}
    monkeypatch.setattr(route,'run_walk_forward_oof_lifecycle',run)
    # Existing exact-cohort continuation must not start prep/training again.
    asyncio.run(job._execute_oof_lifecycle(cadence='monthly',end_date='2026-10-01',promote=False,
        dispatch_full_fit=True,expected_cohort_id='exact-cohort',continuation_attempt=1,continuation_only=True))
    assert received[0].signal_date_max==CUTOFF['signal_date_max']
    assert received[0].label_known_at_max==CUTOFF['label_known_at_max']
    assert received[0].promote is False


def test_prep_event_retains_cutoff_and_distinguishes_bounded_input_owner(monkeypatch):
    from services.oof_prep_events import prep_context
    from services.pipeline_input_events import current_context
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    for key,value in ENV.items():monkeypatch.setenv(key,value)
    with prep_context(cadence='monthly',end_date='2026-10-01',profile='fixture'):
        bounded=dict(current_context())
        assert request_cutoff_from_environment(bounded['oof_resume'])==CUTOFF
    for key in ENV:monkeypatch.delenv(key,raising=False)
    with prep_context(cadence='monthly',end_date='2026-10-01',profile='fixture'):
        assert current_context()['run_id']!=bounded['run_id']


def test_job_callback_carries_cutoff_for_worker_continuation(monkeypatch):
    import oof_materialize_job_main as job
    for key,value in {**ENV,'OOF_MATERIALIZE_CADENCE':'monthly','OOF_MATERIALIZE_PROMOTE':'0',
        'OOF_MATERIALIZE_RUN_ID':'bounded','OOF_MATERIALIZE_CONTINUATION_ATTEMPT':'0',
        'OOF_MATERIALIZE_MODE':'oof_lifecycle'}.items():monkeypatch.setenv(key,value)
    messages=[]
    async def run(**kwargs):return {'status':'pending','cohort_id':'exact','dependency_retry_required':True}
    async def callback(body):messages.append(body)
    monkeypatch.setattr(job,'_execute_lifecycle',run)
    monkeypatch.setattr(job,'_callback_worker',callback)
    assert asyncio.run(job._run())==0
    assert messages[0]['metadata']['training_cutoff']==CUTOFF


def test_bounded_request_never_reuses_unbounded_predispatch_receipt(monkeypatch):
    from routers import walk_forward as route
    def forbidden(*args, **kwargs):raise AssertionError('legacy unbounded lookup')
    monkeypatch.setattr(route,'_latest_ready_oof_manifest',forbidden)
    monkeypatch.setattr(route,'_exact_ready_oof_manifest',forbidden)
    for exact in (False, True):
        req=route.OofLifecycleRequest(cadence='monthly',promote=False,
            continuation_only=exact,expected_cohort_id='bounded' if exact else None,**CUTOFF)
        assert route._pre_dispatch_completed_oof_lifecycle(req,cadence='monthly',bucket=object()) is None


def test_invalid_cutoff_closes_job_with_error_callback_without_dispatch(monkeypatch):
    import oof_materialize_job_main as job
    for key,value in {**ENV,'OOF_MATERIALIZE_SIGNAL_DATE_MAX':'',
        'OOF_MATERIALIZE_MODE':'oof_lifecycle','OOF_MATERIALIZE_CADENCE':'monthly'}.items():
        monkeypatch.setenv(key,value)
    messages=[]
    async def forbidden(**kwargs):raise AssertionError('must reject before dispatch')
    async def callback(body):messages.append(body)
    monkeypatch.setattr(job,'_execute_lifecycle',forbidden)
    monkeypatch.setattr(job,'_callback_worker',callback)
    assert asyncio.run(job._run())==1
    assert len(messages)==1 and messages[0]['status']=='error'
    assert 'training_dual_cutoff_requires_both_bounds' in messages[0]['error']


@pytest.mark.parametrize('manifest_ready', [False, True])
def test_lifecycle_dry_run_never_repairs_cloud_dispatch_records(monkeypatch, manifest_ready):
    import json
    from datetime import date, timedelta
    from routers import walk_forward as route
    from services import walk_forward_retrain, trading_config_loader, modal_client, l4_oof_lifecycle
    days = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range(150)]
    probe_calls = []
    class Blob:
        def __init__(self, path): self.path = path
        def exists(self): return self.path.endswith('dispatch.json') or manifest_ready
        def download_as_text(self):
            return json.dumps({'status': 'spawned', 'function_call_id': 'original'} if self.path.endswith('dispatch.json')
                              else {'status': 'ready', 'cohort_id': 'fixture', 'end_date': days[-1]})
        def upload_from_string(self, *args, **kwargs):
            raise AssertionError('dry_run attempted cloud mutation')
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: SimpleNamespace(blob=Blob))
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
                        lambda: SimpleNamespace(config={'l4Distribution': {}}))
    monkeypatch.setattr(route, '_latest_ready_oof_manifest', lambda *args, **kw: None)
    monkeypatch.setattr(route, '_latest_canonical_prep_prefix', lambda *args, **kw: 'verified-prep')
    monkeypatch.setattr(route, '_oof_lifecycle_calendar', lambda *args, **kw: (days, {'cutoff': '2026-10-01'}))
    async def probe(call_id):
        probe_calls.append(call_id)
        return {'status': 'completed'}
    async def preview(plan):
        assert not plan.confirm
        return {'dry_run': True}
    async def materialize(**kwargs):
        assert kwargs['dry_run'] is True
        return {'status': 'dry_run'}
    monkeypatch.setattr(modal_client, 'probe_modal_function_call', probe)
    monkeypatch.setattr(route, 'walk_forward_dry_run', preview)
    monkeypatch.setattr(l4_oof_lifecycle, 'materialize_native_base', materialize)
    result = asyncio.run(route.run_walk_forward_oof_lifecycle(route.OofLifecycleRequest(
        cadence='monthly', dry_run=True, promote=False, **CUTOFF)))
    assert result['status'] == 'dry_run'
    assert probe_calls == ([] if manifest_ready else ['original'])
