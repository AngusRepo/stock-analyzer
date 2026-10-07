import io,json,hashlib
from types import SimpleNamespace
import numpy as np
import pytest
from fastapi import HTTPException
from app.regime import RegimeDetector
from app.regime_inference import compute_regime_current
from services.hmm_input_contract import CONTRACT_HASH,SOURCE,checksum,FEATURES

def environment():
    history={f"2026-06-{i:02d}":{"market_return_1d":.001,"market_return_5d":.005,"risk_score":0,
      "market_bias_20d":.01,"realized_vol_3d":.002,"benchmark_source":SOURCE,"risk_quality_status":"score_verified"} for i in range(1,21)}
    return {"history":history,"requested_run_date":"2026-06-20","hmm_input_contract":CONTRACT_HASH,"hmm_input_checksum":checksum(history)}

def test_missing_expired_or_incompatible_model_does_not_fit_or_save(monkeypatch):
    calls=[]
    monkeypatch.setattr(RegimeDetector,"load_from_gcs",classmethod(lambda cls:None))
    monkeypatch.setattr(RegimeDetector,"fit",lambda *a,**k:calls.append("fit"))
    monkeypatch.setattr(RegimeDetector,"save_to_gcs",lambda *a,**k:calls.append("save"))
    with pytest.raises(HTTPException) as exc:compute_regime_current(environment())
    assert exc.value.status_code==503 and calls==[]
    with pytest.raises(HTTPException) as exc:compute_regime_current(environment(),True)
    assert exc.value.status_code==409 and calls==[]

def test_legacy_contract_bad_width_nonfinite_or_zero_normalizer_rejected():
    det=RegimeDetector();det._trained=True;det.model=object();det.feature_means=np.zeros(6);det.feature_stds=np.ones(6)
    assert not det.compatible()
    det.input_contract=CONTRACT_HASH
    assert det.compatible()
    for stds in [np.ones(4),np.zeros(6),np.full(6,np.nan)]:
        det.feature_stds=stds;assert not det.compatible()

@pytest.mark.parametrize("kind",["legacy","checksum","generation"])
def test_gcs_metadata_failure_rejects_before_deserialization(monkeypatch,kind):
    from app import model_store
    import joblib
    calls=[]
    metadata={"trained_at":"2026-10-07T00:00:00Z","input_contract":CONTRACT_HASH,"feature_order":list(FEATURES),
      "artifact_generation":"1","artifact_sha256":"0"*64}
    if kind=="legacy":metadata.pop("input_contract")
    if kind=="generation":metadata["artifact_generation"]=""
    class Blob:
        def exists(self):return True
        def download_as_text(self):return json.dumps(metadata)
        def download_to_file(self,buf):buf.write(b"wrong bytes")
    monkeypatch.setattr(model_store,"_get_bucket",lambda:SimpleNamespace(blob=lambda *a,**k:Blob()))
    monkeypatch.setattr(model_store,"is_model_fresh",lambda *a,**k:True)
    monkeypatch.setattr(joblib,"load",lambda *a:calls.append("deserialize"))
    assert RegimeDetector.load_from_gcs() is None and calls==[]

class _GoodModel:
    def predict_proba(self,rows):return np.tile([.1,.9],(len(rows),1))

def test_valid_pinned_artifact_infers_and_historical_future_model_rejects_without_fit(monkeypatch):
    from app import model_store
    import joblib
    det=RegimeDetector();det._trained=True;det.input_contract=CONTRACT_HASH
    det.training_input_checksum="c"*64;det.model=_GoodModel()
    det.feature_means=np.zeros(6);det.feature_stds=np.ones(6);det.regime_map={0:3,1:0}
    blob=io.BytesIO();joblib.dump(det,blob);raw=blob.getvalue()
    meta={"trained_at":"2026-06-19T00:00:00+00:00","input_contract":CONTRACT_HASH,"feature_order":list(FEATURES),
      "artifact_generation":"7","artifact_sha256":hashlib.sha256(raw).hexdigest(),"training_input_checksum":"c"*64}
    generations=[];writes=[]
    class Blob:
        def exists(self):return True
        def download_as_text(self):return json.dumps(meta)
        def download_to_file(self,out):out.write(raw)
    def make_blob(name,**kwargs):
        if name.endswith('joblib'):generations.append(kwargs['generation'])
        return Blob()
    monkeypatch.setattr(model_store,"_get_bucket",lambda:SimpleNamespace(blob=make_blob))
    monkeypatch.setattr(model_store,"is_model_fresh",lambda *a,**k:True)
    monkeypatch.setattr(RegimeDetector,"fit",lambda *a,**k:writes.append('fit'))
    monkeypatch.setattr(RegimeDetector,"save_to_gcs",lambda *a,**k:writes.append('save'))
    result=compute_regime_current(environment())
    assert result['regime_label_en']=='bull_market' and result['sequence_length']==20
    assert result['hmm_provenance']['model']['generation']=='7' and generations==[7] and not writes
    meta['trained_at']='2026-06-21T00:00:00+00:00'
    with pytest.raises(HTTPException) as exc:compute_regime_current(environment())
    assert exc.value.status_code==409 and not writes
    live=environment();live['inference_as_of']='2026-06-21T08:00:00+08:00'
    assert compute_regime_current(live)['regime_label_en']=='bull_market'
    live['inference_as_of']='2099-01-01T00:00:00Z'
    with pytest.raises(HTTPException) as exc:compute_regime_current(live)
    assert exc.value.status_code==400 and not writes
