"""Actual fits must retain OOS evidence while serving the all-known-data refit."""
from datetime import date, timedelta
from types import SimpleNamespace
import numpy as np
import pytest
from app.deployment_refit import requested, row_limit, validate_full_history


def test_full_fit_boundaries_and_uncapped_default():
    assert requested({"generation_mode": "local_full_fit"})
    assert requested({"candidate_type": "oof_full_fit_release"})
    assert not requested({"generation_mode": "purged_oof", "train_end": "2026-01-01"})
    with pytest.raises(ValueError, match="outer_test"):
        requested({"generation_mode": "local_full_fit", "test_start": "2026-01-01"})
    assert row_limit({}, full_fit=True, default=120000) == 0
    assert row_limit({"max_rows": 0}, full_fit=False, default=120000) == 0
    assert row_limit({"data_slice": {"max_rows": 0}}, full_fit=False, default=120000) == 0
    assert row_limit({}, full_fit=False, default=120000) == 120000
    from app.tabm_training import _subsample_indices
    indices=np.arange(150001)
    assert len(_subsample_indices(indices, max_rows=row_limit({}, full_fit=True, default=120000)))==150001


@pytest.mark.parametrize("signals,known,cutoff", [
    (["2026-01-01"], ["2026-01-06"], "2026-01-05"),
    (["2026-01-01"], ["2026-01-01"], "2026-01-06"),
    (["2026-01-01"], [], "2026-01-06"),
    (["2026-01-01"], ["2026-01-06"], None),
])
def test_full_fit_rejects_future_or_incomplete_lineage(signals, known, cutoff):
    with pytest.raises(ValueError):
        validate_full_history(signal_dates=signals, label_known_dates=known, cutoff=cutoff)


def test_dlinear_really_refits_all_windows_without_replacing_validation():
    import torch
    from app.dlinear_universal import train_dlinear
    torch.set_num_threads(2)
    dates=[str(date(2026,1,1)+timedelta(days=i)) for i in range(40)]
    records=[{"symbol":str(i),"market_type":"LISTED","dates":dates,
              "close":[100+i+j*.2+np.sin(j) for j in range(40)],
              "open":[100+i+j*.2 for j in range(40)]} for i in range(3)]
    args=dict(series_close=[],sequence_records=records,seq_len=4,pred_len=2,kernel=3,
              n_epochs=3,batch_size=16,device="cpu",seed=42)
    validation=train_dlinear(**args)
    full=train_dlinear(**args,full_fit=True,knowledge_cutoff_date=dates[-1])
    for key in ("oos_ic","oos_samples","best_val_loss","model_cpcv","history"):
        assert full["metadata"][key]==validation["metadata"][key]
    meta=full["metadata"]
    assert meta["checkpoint_selection"]=="full_refit_final_epoch"
    assert meta["deployment_fit"]["performed"] is True
    assert meta["n_train_windows"]==105
    assert meta["n_train_windows"]>validation["metadata"]["n_train_windows"]
    assert meta["deployment_fit"]["train_range"]==[dates[3],dates[-3]]
    assert any(not torch.equal(v,validation["_state_dict_torch"][k]) for k,v in full["_state_dict_torch"].items())


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


@pytest.mark.parametrize("name",["TabM","GNN"])
def test_native_tabular_refit_preserves_oos_and_uses_all_dates(monkeypatch,name):
    import torch
    torch.set_num_threads(2)
    from app import tabm_training as tabm, gnn_training as gnn
    module=tabm if name=="TabM" else gnn
    data=panel()
    captured=[]
    monkeypatch.setattr(module,"_get_bucket",lambda: object())
    monkeypatch.setattr(module,"collect_prep_lineage",lambda *a,**k: {})
    def save(*,model,metadata,**kwargs):
        captured.append({k:v.detach().cpu().clone() for k,v in model.state_dict().items()})
        return {"artifact_path":"local.pt","metadata_path":"local.json","checksum":"local", "metadata":metadata}
    monkeypatch.setattr(module,"_save_artifact",save)
    if name=="TabM":
        pytest.importorskip("tabm")
        monkeypatch.setattr(tabm,"load_tabular_dataset",lambda _:data)
        train=tabm.train_tabm_universal
    else:
        pytest.importorskip("torch_geometric")
        monkeypatch.setattr(gnn,"_load_npz_batches",lambda *a,**k:(
            data.X,data.y,data.target_returns,data.dates,data.sectors,data.symbols,data.markets,
            data.label_known_dates,{"prep_objects":0,"prep_bytes":0}))
        monkeypatch.setattr(gnn,"_load_feature_names",lambda *a,**k:data.feature_names)
        train=gnn.train_graphsage_universal
    args={"epochs":1,"batch_size":256,"run_date":"2026-03-10","seed":42}
    before=train(args)
    after=train({**args,"generation_mode":"local_full_fit"})
    assert before["metadata"]["metrics"]==after["metadata"]["metrics"]
    assert before["metadata"]["model_cpcv"]==after["metadata"]["model_cpcv"]
    assert after["train_samples"]==1200>before["train_samples"]
    assert after["metadata"]["train_range"]==["2026-01-01","2026-03-01"]
    assert after["metadata"]["validation_train_range"]==before["metadata"]["train_range"]
    assert after["metadata"]["deployment_fit"]["performed"] is True
    assert any(not torch.equal(v,captured[0][k]) for k,v in captured[1].items())
    if name=="TabM":
        with pytest.raises(ValueError,match="row_truncation"):
            train({**args,"generation_mode":"local_full_fit","max_rows":1000})


def test_native_tree_artifact_is_refitted_with_same_capacity(monkeypatch):
    import io
    import json
    import joblib
    from app import universal_training as ut
    data=panel()
    raw=io.BytesIO()
    np.savez(raw, X=data.X, y=data.y, target_returns=data.target_returns, dates=data.dates,
             symbols=data.symbols, markets=data.markets, label_known_dates=data.label_known_dates)
    class Bucket:
        def __init__(self): self.values={}
        def blob(self,name):
            parent=self
            class Blob:
                def exists(self,**kwargs):return name in parent.values
                def download_as_text(self,**kwargs):return parent.values[name].decode()
                def download_as_bytes(self,**kwargs):return parent.values[name]
                def upload_from_string(self,value,**kwargs):parent.values[name]=value.encode() if isinstance(value,str) else value
                def upload_from_file(self,stream,**kwargs):parent.values[name]=stream.read()
            return Blob()
    bucket=Bucket()
    monkeypatch.setattr(ut,"_get_bucket",lambda:bucket)
    monkeypatch.setattr(ut,"download_existing_blobs",lambda *a,**k:[("universal/prep/batch_0.npz",raw.getvalue())])
    monkeypatch.setattr(ut,"collect_prep_lineage",lambda *a,**k:{})
    base=dict(batch_count=1,models_filter=["LightGBM","XGBoost","ExtraTrees"],
              run_date="2026-03-10",register_challengers=False,
              disable_stale_prep_guard=True,enable_model_cpcv=False)
    # This fixture suppresses remote IO and unrelated expensive CPCV; actual native estimators are unchanged.
    validation=ut.train_universal_from_gcs(ut.UniversalTrainRequest(**base,output_model_version="fixture-validation"))
    full=ut.train_universal_from_gcs(ut.UniversalTrainRequest(**base,output_model_version="fixture-full",generation_mode="local_full_fit"))
    assert full["train_samples"]==1200>validation["train_samples"]
    assert set(full["artifact_registrations"])==set(base["models_filter"])
    for name,artifact in full["artifact_registrations"].items():
        previous=validation["artifact_registrations"][name]
        assert artifact["oos_ic"]==previous["oos_ic"]
        meta=artifact["metadata"]
        assert meta["sample_count"]==1200
        assert meta["deployment_fit"]["performed"] is True
        def estimator(receipt):
            saved=joblib.load(io.BytesIO(bucket.values[receipt["gcs_path"]]))
            return saved["model"] if isinstance(saved,dict) else saved
        model=estimator(artifact)
        old=estimator(previous)
        assert json.dumps(model.get_params(),sort_keys=True)==json.dumps(old.get_params(),sort_keys=True)
        assert model.get_params()["n_estimators"]==300
        assert not np.array_equal(model.predict(data.X),old.predict(data.X))
