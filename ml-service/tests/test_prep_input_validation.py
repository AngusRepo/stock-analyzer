import io
import numpy as np
import pytest
from app.prep_input_validation import validate_tabular_batch, validate_prep_keys, validate_feature_names
from app import universal_training as ut
from app.research_benchmarks import common


def arrays():
    return dict(X=np.array([[0.,2.],[1.,0.]]),y=np.array([.2,.8]),target_returns=np.array([-.01,.01]),
                dates=np.array(["2026-01-02","2026-01-02"]),symbols=np.array(["2330","3004"]),
                markets=np.array(["TW","TW"]),label_known_dates=np.array(["2026-01-09","2026-01-09"]),
                missingness_rates=np.array([0.,1.]))


def encode(values):
    buf=io.BytesIO();np.savez(buf,**values);return buf.getvalue()


def test_legitimate_zero_and_fully_missing_disclosure_are_allowed():
    with np.load(io.BytesIO(encode(arrays()))) as data:
        validate_tabular_batch(data,key="batch")


@pytest.mark.parametrize("change,error", [
    (lambda a:a.pop("missingness_rates"),"required_fields_missing"),
    (lambda a:a.update(missingness_rates=np.array([np.nan,0.])),"missingness_invalid"),
    (lambda a:a.update(missingness_rates=np.array([0.])),"missingness_invalid"),
    (lambda a:a.update(missingness_rates=np.array([0.,1.1])),"missingness_invalid"),
    (lambda a:a.update(target_returns=np.array([.1])),"row_alignment_invalid"),
    (lambda a:a.update(X=np.array([[np.inf,0.],[0.,0.]])),"features_invalid"),
    (lambda a:a.update(label_known_dates=np.array(["2026-01-02","2026-01-09"])),"label_dates_invalid"),
    (lambda a:a.update(label_known_dates=np.array(["NaT","2026-01-09"])),"label_dates_invalid"),
])
def test_invalid_batch_fails(change,error):
    values=arrays();change(values)
    with np.load(io.BytesIO(encode(values))) as data,pytest.raises(ValueError,match=error):
        validate_tabular_batch(data,key="batch")


def test_duplicate_keys_across_batches_fail():
    with pytest.raises(ValueError,match="duplicate"):
        validate_prep_keys(["2026-01-02"]*2,["2330"]*2,["TW"]*2)
    validate_prep_keys(["2026-01-02"]*2,["2330","3004"],["TW"]*2)


@pytest.mark.parametrize("names", [["a"],["a","a"],["a",""]])
def test_feature_names_fail(names):
    with pytest.raises(ValueError,match="feature_names_invalid"):
        validate_feature_names(names,2)


def test_universal_missing_batch_fails_before_any_fit(monkeypatch):
    monkeypatch.setattr(ut,"_get_bucket",lambda:object())
    monkeypatch.setattr(ut,"download_existing_blobs",lambda *a,**k:iter([("missing",None)]))
    with pytest.raises(ValueError,match="prep_batch_missing"):
        ut.train_universal_from_gcs(ut.UniversalTrainRequest(batch_count=1))


def test_universal_missing_metadata_fails_before_any_fit(monkeypatch):
    values=arrays();values.pop("missingness_rates")
    monkeypatch.setattr(ut,"_get_bucket",lambda:object())
    monkeypatch.setattr(ut,"download_existing_blobs",lambda *a,**k:iter([("batch",encode(values))]))
    with pytest.raises(ValueError,match="required_fields_missing"):
        ut.train_universal_from_gcs(ut.UniversalTrainRequest(batch_count=1))


@pytest.mark.parametrize("loader",[common.load_tabular_dataset,common.load_sequence_dataset])
def test_other_consumers_missing_batch_fails(monkeypatch,loader):
    from app import gcs_batch_io
    monkeypatch.setattr(common,"_bucket",lambda:object())
    monkeypatch.setattr(gcs_batch_io,"download_existing_blobs",lambda *a,**k:iter([("missing",None)]))
    with pytest.raises(ValueError,match="batch_missing"):
        loader({"batch_count":1})
