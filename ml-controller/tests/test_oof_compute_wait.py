import asyncio
import json
from types import SimpleNamespace
import pytest
import oof_materialize_job_main as job
from services.oof_continuation import continuation_limit, probe_exact_cohort_wait


def test_only_verified_running_compute_uses_long_wait_budget():
    assert continuation_limit({'external_compute_pending': True}) == 64
    assert continuation_limit({'external_compute_pending': True, 'nav_retry_required': True}) == 12
    for result in [{'status': 'pending'}, {'compute_probe': {'status': 'unknown'}},
                   {'full_fit_dispatch': {'status': 'blocked', 'reason': 'full_fit_retry_limit_reached'}}]:
        assert continuation_limit(result) == 12
    assert continuation_limit({'full_fit_dispatch': {'reason': 'modal_full_fit_still_running', 'modal_poll': {'status': 'pending'}}}) == 64


@pytest.mark.parametrize('attempt,expected', [(12,'triggered'), (63,'triggered'), (64,'error')])
def test_running_modal_after_old_limit_still_continues_without_marking_success(monkeypatch, attempt, expected):
    callbacks = []
    async def execute(**kwargs):
        return {'status': 'pending', 'cohort_id': 'exact-price', 'external_compute_pending': True}
    async def callback(payload):
        callbacks.append(payload)
    monkeypatch.setattr(job, '_execute_lifecycle', execute)
    monkeypatch.setattr(job, '_callback_worker', callback)
    monkeypatch.setenv('OOF_MATERIALIZE_CADENCE','weekly')
    monkeypatch.setenv('OOF_MATERIALIZE_END_DATE','2026-09-18')
    monkeypatch.setenv('OOF_MATERIALIZE_CONTINUATION_ATTEMPT',str(attempt))
    assert asyncio.run(job._run()) == int(expected == 'error')
    assert callbacks[0]['status'] == expected
    assert callbacks[0]['metadata']['continuation_max_attempts'] == 64


@pytest.mark.parametrize('state', ['running','unknown','failed','completed'])
def test_exact_missing_manifest_probes_original_call_never_retrains(monkeypatch, state):
    from services import modal_client
    calls = []
    async def probe(call_id):
        calls.append(call_id)
        return {'status':state}
    monkeypatch.setattr(modal_client,'probe_modal_function_call',probe)
    bucket=SimpleNamespace(blob=lambda path: SimpleNamespace(exists=lambda: path.endswith('dispatch.json'),
        download_as_text=lambda: json.dumps({'function_call_id':'original-call'})))
    if state in ('failed','completed'):
        with pytest.raises(ValueError,match='terminal_without_ready_manifest'):
            asyncio.run(probe_exact_cohort_wait(bucket,'exact-exo137'))
    else:
        result=asyncio.run(probe_exact_cohort_wait(bucket,'exact-exo137'))
        assert result['external_compute_pending'] == (state == 'running')
    assert calls == ['original-call']


def test_manifest_publication_during_probe_reloads_exact_manifest(monkeypatch):
    from services import modal_client
    async def probe(call_id): return {'status':'completed'}
    monkeypatch.setattr(modal_client,'probe_modal_function_call',probe)
    bucket=SimpleNamespace(blob=lambda path: SimpleNamespace(exists=lambda: True,
        download_as_text=lambda: json.dumps({'function_call_id':'original-call'})))
    assert asyncio.run(probe_exact_cohort_wait(bucket,'exact-price')) == {'manifest_published':True}


@pytest.mark.parametrize('variant', ['price', 'exo137'])
def test_actual_exact_continuation_after_twelve_polls_preserves_cohort(monkeypatch, variant):
    from routers import walk_forward
    from services import modal_client, walk_forward_retrain, trading_config_loader
    cohort = 'active8-oof-v4-timexer-' + variant
    calls = []
    async def probe(call_id):
        calls.append(call_id)
        return {'status':'running','function_call_id':call_id}
    bucket = SimpleNamespace(blob=lambda path: SimpleNamespace(
        exists=lambda: path.endswith('dispatch.json'),
        download_as_text=lambda: json.dumps({'function_call_id':'original-'+variant})))
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',lambda:bucket)
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={}))
    monkeypatch.setattr(modal_client,'probe_modal_function_call',probe)
    monkeypatch.setenv('OOF_MATERIALIZE_JOB_EXECUTION','1')
    result = asyncio.run(walk_forward.run_walk_forward_oof_lifecycle(walk_forward.OofLifecycleRequest(
        cadence='weekly', end_date='2026-09-18', expected_cohort_id=cohort,
        continuation_only=True, continuation_attempt=13, promote=False,
        model_profile_schema_version='active8-release-model-profiles-v4-timexer-'+variant)))
    assert result['cohort_id'] == cohort
    assert result['training_dispatched'] is result['promotion_attempted'] is False
    assert result['external_compute_pending'] is True
    assert calls == ['original-'+variant]
    assert continuation_limit(result) == 64
