"""C28-16 S1: one bad symbol stays local (HL2-1b); raw-score and median-fill reports (HL3-4e, NEW-76)."""
import numpy as np
import pytest

from app import batch_prediction
from test_batch_prediction import _full_model_pool, _predict_payload


class _Model:
    def __init__(self, values):
        self.values, self.calls = values, []

    def predict(self, x_batch):
        self.calls.append(tuple(x_batch.shape))
        return np.asarray(self.values[: x_batch.shape[0]], dtype=np.float64)


def _setup(monkeypatch, model, meta):
    pool = _full_model_pool({"XGBoost": "active"})
    monkeypatch.setattr(batch_prediction, "_load_model_pool", lambda: pool)
    monkeypatch.setattr(batch_prediction, "_load_feature_artifact",
                        lambda name, explicit_path=None, **kw: (model, meta) if name == "XGBoost" else (None, {}))
    return pool


def _requests(*symbols):
    from app.schemas import PredictRequest
    return [PredictRequest(**_predict_payload(s, int(s), 100.0)) for s in symbols]


def test_one_bad_feature_context_errors_only_its_symbol(monkeypatch):
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY
    model = _Model([0.2, 0.6])
    _setup(monkeypatch, model, {"feature_names": [], "feature_medians": {}})
    real = batch_prediction._build_feature_batch_context

    def build(req):
        if req.symbol == "2317":
            raise ValueError("bad bars")
        return real(req)
    monkeypatch.setattr(batch_prediction, "_build_feature_batch_context", build)
    overrides = batch_prediction._build_feature_model_batch_runtime_overrides(_requests("2330", "2317", "2454"))
    assert len(overrides) == 3 and model.calls == [(2, model.calls[0][1])]
    assert overrides[0][_BATCH_FEATURE_RANK_SCORES_KEY]["XGBoost"] == pytest.approx(0.2)
    assert overrides[2][_BATCH_FEATURE_RANK_SCORES_KEY]["XGBoost"] == pytest.approx(0.6)
    assert batch_prediction._feature_core_coverage_error(overrides[1]) == \
        "feature_context_failed:ValueError:bad bars"


def test_serving_report_keeps_raw_scores_and_median_fill_without_changing_scores(monkeypatch):
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY
    requests = _requests("2330", "2317")
    ctx = batch_prediction._build_feature_batch_context(requests[0])
    names = list(ctx.feature_names)
    meta = {"feature_names": [*names, "absent_feature"], "feature_medians": {"absent_feature": 0.0}}
    model = _Model([-0.3, 1.4])
    _setup(monkeypatch, model, meta)
    from app import artifact_contract
    monkeypatch.setattr(artifact_contract, "validate_serving_feature_compatibility", lambda **kw: None)
    sink = []
    token = batch_prediction._SERVING_REPORT_TELEMETRY.set(sink)
    try:
        overrides = batch_prediction._build_feature_model_batch_runtime_overrides(requests)
    finally:
        batch_prediction._SERVING_REPORT_TELEMETRY.reset(token)
    assert [o[_BATCH_FEATURE_RANK_SCORES_KEY]["XGBoost"] for o in overrides] == [0.0, 1.0]   # clip unchanged
    report = batch_prediction._serving_report(sink, [{"error": "feature_context_failed:X"}, {}])
    assert report["schema_version"] == "l3-serving-robustness-report-v1"
    assert report["feature_context_errors"] == 1
    assert report["raw_score_dispersion"]["XGBoost"] == {
        "n": 2, "non_finite": 0, "std": pytest.approx(0.85), "unique": 2, "below_0": 1, "above_1": 1}
    assert report["median_filled_features"]["XGBoost"] == {"rows": 2, "features": ["absent_feature"]}


def test_with_metrics_carries_the_serving_report(monkeypatch):
    model = _Model([0.4, 0.5])
    pool = _setup(monkeypatch, model, {"feature_names": [], "feature_medians": {}})
    payloads = [_predict_payload("2330", 2330, 100.0), _predict_payload("2317", 2317, 80.0)]
    out = batch_prediction.predict_stock_v2_batch_with_metrics(payloads, pool_snapshot=pool)
    report = out["metrics"]["serving_report"]
    assert report["schema_version"] == "l3-serving-robustness-report-v1"
    assert isinstance(report["raw_score_dispersion"], dict) and report["feature_context_errors"] == 0


def test_challenger_scores_stay_out_of_the_raw_report():
    from types import SimpleNamespace
    ctx = SimpleNamespace(rank_scores={}, challenger_rank_scores={}, raw_scores={})
    batch_prediction._record_feature_score(ctx, "XGBoost", 2.0, challenger=True)
    batch_prediction._record_feature_score(ctx, "LightGBM", -0.5)
    assert ctx.raw_scores == {"LightGBM": -0.5} and ctx.challenger_rank_scores == {"XGBoost": 1.0}
