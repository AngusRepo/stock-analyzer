"""Nested tree diagnostics must remain inside the purged outer training window."""
import io
import json
import joblib
import numpy as np
import pytest
from datetime import date, timedelta
from types import SimpleNamespace
from app import universal_training as ut, model_validation
from app.purged_cv import purged_explicit_walk_forward_indices


def panel():
    rng=np.random.default_rng(42)
    days=[str(date(2026,1,1)+timedelta(days=i)) for i in range(60)]
    dates=np.repeat(days,20)
    known=np.repeat([str(date.fromisoformat(d)+timedelta(days=5)) for d in days],20)
    return SimpleNamespace(X=rng.normal(size=(1200,3)).astype(np.float32),
        y=rng.random(1200).astype(np.float32),target_returns=rng.normal(size=1200).astype(np.float32),
        dates=dates,label_known_dates=known,sectors=np.tile(["A","B"],600),
        symbols=np.tile([str(i) for i in range(20)],60),markets=np.repeat("LISTED",1200),
        feature_names=["f0","f1","f2"],source="local-fixture")

@pytest.mark.parametrize('outer_window', [True, False])
def test_real_tree_cpcv_scope_and_unchanged_saved_predictions(monkeypatch, outer_window):
    data=panel();raw=io.BytesIO()
    np.savez(raw,X=data.X,y=data.y,target_returns=data.target_returns,dates=data.dates,
        symbols=data.symbols,markets=data.markets,label_known_dates=data.label_known_dates, missingness_rates=np.zeros(len(data.feature_names)))
    class Bucket:
        def __init__(self):self.values={}
        def blob(self,name):
            owner=self
            class Blob:
                def exists(self,**kw):return name in owner.values
                def download_as_bytes(self,**kw):return owner.values[name]
                def download_as_text(self,**kw):return owner.values[name].decode()
                def upload_from_string(self,value,**kw):owner.values[name]=value.encode() if isinstance(value,str) else value
                def upload_from_file(self,stream,**kw):owner.values[name]=stream.read()
            return Blob()
    bucket=Bucket()
    bucket.values["universal/prep/feature_names.json"]=json.dumps(data.feature_names).encode()
    monkeypatch.setattr(ut,'_get_bucket',lambda:bucket)
    monkeypatch.setattr(ut,'download_existing_blobs',lambda *a,**k:[('fixture/prep/batch_0.npz',raw.getvalue())])
    monkeypatch.setattr(ut,'collect_prep_lineage',lambda *a,**k:{})
    bounds=dict(train_start='2026-01-10',train_end='2026-02-15',test_start='2026-02-16',test_end='2026-02-25')
    expected=purged_explicit_walk_forward_indices(data.dates,label_known_dates=data.label_known_dates,
        label_horizon_days=5,**bounds)[0] if outer_window else np.arange(len(data.X))
    seen=[]
    original=model_validation.evaluate_model_cpcv_rank_ic
    def capture(**kwargs):
        np.testing.assert_array_equal(kwargs['X'],data.X[expected])
        np.testing.assert_array_equal(kwargs['dates'],data.dates[expected])
        # Real CV estimator callbacks execute against indices relative to this scoped pool.
        answer=original(**kwargs)
        seen.append(kwargs['model'])
        return answer
    monkeypatch.setattr(model_validation,'evaluate_model_cpcv_rank_ic',capture)
    base=dict(gcs_prefix='universal',batch_count=1,models_filter=['LightGBM','XGBoost','ExtraTrees'],
        run_date='2026-03-10',register_challengers=False,disable_stale_prep_guard=True)
    if outer_window:base.update(bounds,window_id=1)
    else:base['generation_mode']='local_full_fit'
    before=ut.train_universal_from_gcs(ut.UniversalTrainRequest(**base,output_model_version='without-inner-cv',enable_model_cpcv=False))
    after=ut.train_universal_from_gcs(ut.UniversalTrainRequest(**base,output_model_version='with-inner-cv',enable_model_cpcv=True))
    assert set(seen)==set(base['models_filter'])
    assert 'ModelCPCV' not in after['results'],after['results'].get('ModelCPCV')
    for name,receipt in after['artifact_registrations'].items():
        evidence=after['results'][name]['model_cpcv']
        assert evidence['data_scope']=={'source':'purged_outer_train' if outer_window else 'full_training_prep',
            'rows':len(expected),'date_min':str(min(data.dates[expected])),'date_max':str(max(data.dates[expected]))}
        prior=before['artifact_registrations'][name]
        def predictions(row):
            obj=joblib.load(io.BytesIO(bucket.values[row['gcs_path']]))
            return (obj['model'] if isinstance(obj,dict) else obj).predict(data.X)
        np.testing.assert_allclose(predictions(receipt),predictions(prior),rtol=0,atol=1e-12)
        assert receipt['oos_ic']==prior['oos_ic']


def test_r33_fold_outer_test_evidence_skips_nested_cpcv(monkeypatch):
    data=panel();raw=io.BytesIO()
    np.savez(raw,X=data.X,y=data.y,target_returns=data.target_returns,dates=data.dates,
        symbols=data.symbols,markets=data.markets,label_known_dates=data.label_known_dates, missingness_rates=np.zeros(len(data.feature_names)))
    class Bucket:
        def __init__(self):self.values={}
        def blob(self,name):
            owner=self
            class Blob:
                def exists(self,**kw):return name in owner.values
                def download_as_bytes(self,**kw):return owner.values[name]
                def download_as_text(self,**kw):return owner.values[name].decode()
                def upload_from_string(self,value,**kw):owner.values[name]=value.encode() if isinstance(value,str) else value
                def upload_from_file(self,stream,**kw):owner.values[name]=stream.read()
            return Blob()
    bucket=Bucket()
    bucket.values["universal/prep/feature_names.json"]=json.dumps(data.feature_names).encode()
    monkeypatch.setattr(ut,'_get_bucket',lambda:bucket)
    monkeypatch.setattr(ut,'download_existing_blobs',lambda *a,**k:[('fixture/prep/batch_0.npz',raw.getvalue())])
    monkeypatch.setattr(ut,'collect_prep_lineage',lambda *a,**k:{})
    monkeypatch.setattr(model_validation,'evaluate_model_cpcv_rank_ic',lambda **k:pytest.fail('nested CPCV must not run in an R33 OOF fold'))
    base=dict(gcs_prefix='universal',batch_count=1,models_filter=['LightGBM','ExtraTrees'],run_date='2026-03-10',
        register_challengers=False,disable_stale_prep_guard=True,train_start='2026-01-10',train_end='2026-02-15',
        test_start='2026-02-16',test_end='2026-02-25',window_id=1,output_model_version='r33-fold')
    result=ut.train_universal_from_gcs(ut.UniversalTrainRequest(**base,fold_model_cpcv='outer_test_date_panel'))
    for name in base['models_filter']:
        evidence=result['results'][name]['model_cpcv']
        assert evidence['method']=='outer_test_date_panel_rank_ic' and evidence['folds']==10
        assert evidence['data_scope']['nested_cpcv']=='skipped_r33_oof_fold'
        # The OOF manifest's coverage contract (modal_app._oof_coverage_contract) needs these.
        assert 0.0<=float(evidence.get('coverage_gate_value',evidence.get('coverage_mean')))<=1.0
        assert evidence['policy']['coverage_mode']=='date_symbol_panel'
        assert evidence.get('coverage_gate_semantics') not in (None,'','unspecified')
    import modal_app
    from app.formal_feature_contract import R33_PROFILE, EXO131_PROFILE
    assert all(modal_app._oof_coverage_contract(result['results'][n]['model_cpcv']) for n in base['models_filter'])
    assert modal_app._r33_outer_test_fold_evidence(R33_PROFILE) and not modal_app._r33_outer_test_fold_evidence(EXO131_PROFILE)


def test_r33_full_fit_never_dispatches_the_1800s_split_parent(monkeypatch):
    import inspect
    import modal_app
    from app.formal_feature_contract import R33_PROFILE, EXO131_PROFILE
    monkeypatch.delenv('UNIVERSAL_TREE_MODEL_SPLIT', raising=False)
    split = {'tree_model_split': True}
    # R33 full-fit: children keep nested CPCV (~40-45 min each), so the waiter must be the 5400 s function.
    assert modal_app._tree_group_function(split, R33_PROFILE) is modal_app.train_tree_models
    assert modal_app._tree_group_function({}, R33_PROFILE) is modal_app.train_tree_models
    # Every other profile keeps its previous routing unchanged.
    assert modal_app._tree_group_function(split, EXO131_PROFILE) is modal_app.train_tree_models_split_parent
    assert modal_app._tree_group_function(split, None) is modal_app.train_tree_models_split_parent
    assert modal_app._tree_group_function({}, EXO131_PROFILE) is modal_app.train_tree_models
    # The retrain orchestrator's tree group is the only spawn site and routes through the helper.
    source = inspect.getsource(modal_app)
    assert 'train_tree_models_split_parent.spawn' not in source and source.count('_tree_group_function(') == 2
