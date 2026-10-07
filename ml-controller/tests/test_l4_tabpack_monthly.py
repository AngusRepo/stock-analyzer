import json
from types import SimpleNamespace
import pytest
from google.api_core.exceptions import PreconditionFailed

from services.l4_distribution import digest
from services import l4_tabpack_dispatch as dispatch
from services.l4_tabpack_weights import SCHEMA


class Bucket:
    def __init__(self): self.saved = {}
    def blob(self, key):
        def upload(raw, **kwargs):
            assert kwargs['if_generation_match'] == 0
            if key in self.saved: raise PreconditionFailed('duplicate')
            self.saved[key] = raw.encode() if isinstance(raw, str) else raw
        return SimpleNamespace(exists=lambda: key in self.saved, upload_from_string=upload,
            download_as_bytes=lambda: self.saved[key], download_as_text=lambda: self.saved[key].decode())


def test_retry_never_rebuilds_heads_or_launches_second_paid_run(monkeypatch):
    from services import modal_client
    bucket, calls, fits = Bucket(), [], []
    def lookup(name):
        assert name == 'train_l4_tabpack_candidate'
        return SimpleNamespace(spawn=lambda p: (calls.append(p) or SimpleNamespace(object_id='fc-test')))
    monkeypatch.setattr(modal_client, '_lookup', lookup)
    def build(): fits.append(True); return {'source': 'fixture'}
    first = dispatch.dispatch(bucket, 'a' * 64, build)
    assert first['status'] == 'pending' and first['promoted'] is False
    again = dispatch.dispatch(bucket, 'a' * 64, build)
    assert again['status'] == 'pending' and len(calls) == len(fits) == 1
    assert calls[0]['training_recipe'] == dispatch.RECIPE


def test_lost_dispatch_response_is_not_retried(monkeypatch):
    from services import modal_client
    bucket, calls = Bucket(), []
    def fail(payload): calls.append(payload); raise TimeoutError('response lost')
    monkeypatch.setattr(modal_client, '_lookup', lambda _: SimpleNamespace(spawn=fail))
    with pytest.raises(TimeoutError): dispatch.dispatch(bucket, 'b' * 64, lambda: {})
    assert dispatch.dispatch(bucket, 'b' * 64, lambda: {})['status'] == 'pending'
    assert len(calls) == 1


def test_preparation_failure_is_terminal_before_any_paid_dispatch():
    bucket, key = Bucket(), 'f' * 64
    def fail(): raise ValueError('insufficient_causal_history')
    with pytest.raises(ValueError, match='insufficient_causal_history'):
        dispatch.dispatch(bucket, key, fail)
    result = dispatch.dispatch(bucket, key, lambda: pytest.fail('must not retry'))
    assert result['status'] == 'failed' and result['stage'] == 'prepare_anchor'


def test_completed_receipt_requires_actual_tabpack_artifact():
    bucket, key = Bucket(), 'c' * 64
    candidate = {'model': {'residual_tabpack': {'schema_version': SCHEMA}}, 'challenger_training_source': {'run_key': key}}
    path = 'l4_distribution/candidates/test.json'
    result = {'status': 'validated', 'promoted': False, 'run_key': key, 'model_schema': SCHEMA,
              'training_recipe': dispatch.RECIPE, 'artifact_path': path, 'artifact_checksum': digest(candidate)}
    bucket.saved[path] = json.dumps(candidate).encode()
    completed = 'l4_distribution/tabpack_runs/' + key + '/completed.json'
    bucket.saved[completed] = json.dumps(result).encode()
    assert dispatch.dispatch(bucket, key, lambda: pytest.fail('must not train')) == result
    candidate['model']['residual_mlp'] = {'old': True}
    result['artifact_checksum'] = digest(candidate)
    bucket.saved[path] = json.dumps(candidate).encode()
    bucket.saved[completed] = json.dumps(result).encode()
    with pytest.raises(ValueError, match='receipt_invalid'): dispatch.dispatch(bucket, key, lambda: {})


def test_failed_training_cannot_report_materialized_or_retry_automatically():
    bucket, key = Bucket(), 'd' * 64
    bucket.saved['l4_distribution/tabpack_runs/' + key + '/failed.json'] = json.dumps(
        {'status': 'failed', 'promoted': False, 'retry_requires_review': True}).encode()
    result = dispatch.dispatch(bucket, key, lambda: pytest.fail('must not train'))
    assert result['status'] == 'failed' and result['dependency_retry_required'] is False


def test_single_b_refresh_rejects_implicit_incumbent_parent_and_A(monkeypatch):
    from services import trading_config_loader
    from routers.l4_distribution import RefreshRequest, refresh_distribution
    from fastapi import HTTPException
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
        lambda: SimpleNamespace(config={'l4Distribution': {'operating_mode': 'single_b_tabpack_v1'}}))
    for extra, message in [({}, 'explicit_exo_parent'), ({'strategy_role': 'A'}, 'cannot_train_A')]:
        with pytest.raises(HTTPException, match=message):
            refresh_distribution(RefreshRequest(end_date='2026-10-04', cadence='monthly', **extra))


def test_monthly_lifecycle_rejects_explicit_price_profile_before_dispatch(monkeypatch):
    import asyncio
    from services import trading_config_loader
    from routers.walk_forward import OofLifecycleRequest, run_walk_forward_oof_lifecycle
    from services.active8_release_model_profiles import TIMEXER_PRICE_PROFILE_SCHEMA
    from fastapi import HTTPException
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
        lambda: SimpleNamespace(config={'l4Distribution': {'operating_mode': 'single_b_tabpack_v1'}}))
    with pytest.raises(HTTPException, match='single_b_oof_requires_exogenous_profile'):
        asyncio.run(run_walk_forward_oof_lifecycle(OofLifecycleRequest(cadence='monthly',end_date='2026-10-04',
            model_profile_schema_version=TIMEXER_PRICE_PROFILE_SCHEMA)))


@pytest.mark.parametrize('status,expected,retry', [('pending','pending',True), ('failed','failed',False), ('validated','materialized',False)])
@pytest.mark.parametrize('family',[None,'full_mlp_median'])
def test_native_monthly_closure_waits_for_tabpack(monkeypatch, status, expected, retry, family):
    import asyncio
    from services import l4_oof_lifecycle as native, active8_oof_cohort_materializer as materializer
    from services.active8_release_model_profiles import TIMEXER_EXO_PROFILE_SCHEMA
    from routers import walk_forward as wf
    from scripts import l4_distribution_refresh_job as refresh
    from services import l4_oof_index_receipt as index_receipt
    monkeypatch.setattr(index_receipt, 'reuse_index', lambda *a: None)
    monkeypatch.setattr(index_receipt, 'seal_index', lambda *a: None)
    from services import l4_monthly_closure
    monkeypatch.setattr(l4_monthly_closure, 'seal', lambda *a: {'status':'complete'})
    manifest = {'cohort_id':'monthly', 'manifest_checksum':'a'*64, 'model_profile_schema_version':TIMEXER_EXO_PROFILE_SCHEMA, 'end_date':'2026-09-30'}
    monkeypatch.setattr(materializer, 'load_verified_oof_manifest', lambda *a, **kw: (manifest, {}))
    monkeypatch.setattr(materializer, 'load_oof_prediction_rows', lambda *a, **kw: [])
    monkeypatch.setattr(native, 'persist_base_index', lambda **kw: {'prediction_dates':20, 'min_date':'2026-09-01', 'max_date':'2026-09-30'})
    async def full_fit(**kw):
        return {'status':'completed', 'retry_required':False, 'release_registry':{'ensemble_candidate':{'artifact_id':'new-B-L3'}}}
    monkeypatch.setattr(wf, 'dispatch_oof_full_fit_training', full_fit)
    monkeypatch.setattr(wf, '_materialize_nav_with_reviews', lambda **kw: pytest.fail('monthly must not read NAV'))
    calls = []
    monkeypatch.setattr(refresh, 'execute', lambda **kw: (calls.append(kw) or {'status':status, 'promoted':False, 'run_key':'a'*64, 'artifact_checksum':'b'*64}))
    result = asyncio.run(native.materialize_native_base(manifest_path='fixture', cohort_id='monthly', as_of='2026-10-04',
        cadence='monthly', dry_run=False, dispatch_full_fit=True, poll_only=False, bucket=Bucket(), client=object(), model_family=family))
    assert result['status'] == expected and result['dependency_retry_required'] is retry
    assert calls[0]['strategy_role'] == 'B' and calls[0]['target_l3_artifact_id'] == 'new-B-L3'
    if family is not None:assert calls[0]['model_family']==family
    assert result['promotion_allowed'] is False


@pytest.mark.parametrize('family',['tabpack','full_mlp_median'])
def test_causal_adapter_never_fits_on_validation_or_outer_test(monkeypatch,family):
    from datetime import date, timedelta
    from services import l4_distribution as native
    from app.l4_tabpack_data import prepare
    if family=='full_mlp_median':
        from app.l4_mlp_data import prepare
    from test_l4_distribution import constant_model, features
    model = constant_model()
    rows = [{'date':(date(2026, 1, 1)+timedelta(days=d)).isoformat(),
             'label_known_date':(date(2026, 1, 3)+timedelta(days=d)).isoformat(),
             'l3_training_label_known_max':'2025-12-01', 'l3_identity':{'artifact_id':'B'},
             'prediction_kind':'oof', 'gross_return':(d % 7 - 3)*.01 + j*.001,
             'features':features((d+j+1)/100)} for d in range(90) for j in range(3)]
    test_dates = sorted({r['date'] for r in rows})[-18:]
    train = [r for r in rows if r['label_known_date'] < min(test_dates)]
    anchor = {'model':model, 'l3_identity':{'artifact_id':'B'}, 'training_rows_checksum':digest(train),
              'evaluation':{'dates':test_dates},'model_checksum':digest(model)}
    monkeypatch.setattr(native, 'validate_bundle', lambda *a, **kw: None)
    fits = []
    def fit(data, **kw):
        fits.append(kw['as_of'])
        assert max(r['label_known_date'] for r in data) < kw['as_of']
        return {'model':model, 'training_label_known_max':max(r['label_known_date'] for r in data),
                'model_checksum':digest(model), 'training_rows_checksum':digest(data)}
    monkeypatch.setattr(native, 'fit_candidate', fit)
    arrays, recipe, evidence, held = prepare(rows, anchor, as_of='2026-05-01')
    changed = [{**r, 'gross_return':99.} if r['date'] in test_dates else r for r in rows]
    second, recipe2, evidence2, _ = prepare(changed, anchor, as_of='2026-05-01')
    import numpy as np
    assert recipe == recipe2 and evidence['three_head_folds'] == evidence2['three_head_folds']
    for part in (('train','val') if family=='tabpack' else ('inner','valid','full')):
        for a, b in zip(arrays[part], second[part]): np.testing.assert_array_equal(a,b)
    if family=='tabpack':
        assert len(fits) > 0 and evidence['train_known_max'] < evidence['val_date_min']
        assert evidence['val_known_max'] < evidence['test_date_min'] and len(held) == 54
    else:
        assert evidence['inner_label_known_max']<evidence['validation_start']
        assert evidence['training_label_known_max']<evidence['test_start'] and len(held)==54
        assert evidence['refit_after_selection'] is True


def test_modal_job_failure_and_duplicate_do_not_retrain(monkeypatch):
    from app import l4_tabpack_job as job
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA', 'f'*40)
    bucket, calls = Bucket(), []
    payload = {'expected_source_sha':'f'*40, 'run_key':'e'*64, 'training_recipe':dispatch.RECIPE}
    def fail(*a): calls.append(True); raise TimeoutError('fixture')
    from app import l4_tabpack_stages
    monkeypatch.setattr(l4_tabpack_stages, 'prepare_stage', fail)
    with pytest.raises(TimeoutError): job.run(payload, bucket=bucket)
    result = job.run(payload, bucket=bucket)
    assert result['status'] == 'failed' and len(calls) == 1
    assert dispatch.dispatch(bucket, payload['run_key'], lambda: {})['status'] == 'failed'


def test_v2_runtime_keeps_residual_mean_and_weighted_ensemble(monkeypatch):
    import numpy as np
    from copy import deepcopy
    from services import l4_distribution as native, l4_tabpack_weights as weights
    from test_l4_distribution import constant_model, features
    from test_paper_single_b_tabpack import residual
    anchor = constant_model()
    model = residual(anchor)
    model.update(schema_version=SCHEMA, residual_mean=.02, residual_scale=2.,
        weights={'path':weights.PREFIX+'a'*64+'.npz', 'sha256':'a'*64, 'bytes':100},
        members=[{'member_id':63, 'step':2, 'depth':1, 'weight':.25},
                 {'member_id':63, 'step':3, 'depth':1, 'weight':.75}])
    model['provenance']['upstream_commit']='05a89e21b955f12de84889d662e15ca534019aaa'
    arrays = {}
    for i, factor in enumerate((.1,.2)):
        arrays[f'm{i}_l0_weight']=np.zeros((34,384),np.float32)
        arrays[f'm{i}_l0_weight'][anchor['recipe']['names'].index('LightGBM_raw'),0]=1.
        arrays[f'm{i}_l0_bias']=np.zeros(384,np.float32)
        arrays[f'm{i}_l1_weight']=np.zeros((384,1),np.float32)
        arrays[f'm{i}_l1_weight'][0,0]=factor
        arrays[f'm{i}_l1_bias']=np.zeros(1,np.float32)
    monkeypatch.setattr(weights,'load',lambda ref:arrays)
    model['payload_checksum']=native.digest({k:v for k,v in model.items() if k!='payload_checksum'})
    full = {**anchor,'residual_tabpack':model}
    rows = [{'features':features(v)} for v in (.1,.5,.9)]
    output = native.predict(rows,full)
    assert [r['residual_ev_correction'] for r in output] == pytest.approx([.055,.195,.335])
    assert native.predict(rows[::-1],full) == output[::-1]
    assert all(p['calibration_model']==SCHEMA for p in output)
    for row, expected in zip(rows,output):
        assert native.predict([row],full)[0]['expected_return_gross'] == pytest.approx(expected['expected_return_gross'])
