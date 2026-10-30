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


def test_r33_pool_keeps_a_row_with_one_model_missing():
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY, _BATCH_MODEL_POOL_KEY
    pool = _full_model_pool({"XGBoost": "active", "LightGBM": "active"})
    override = {_BATCH_FEATURE_RANK_SCORES_KEY: {"LightGBM": 0.4}, _BATCH_MODEL_POOL_KEY: pool}
    assert "XGBoost" in (batch_prediction._feature_core_coverage_error(override) or "")
    r33_pool = {**pool, "active8_ensemble": {"kind": "r33_equal7_isotonic"}}
    assert batch_prediction._feature_core_coverage_error({**override, _BATCH_MODEL_POOL_KEY: r33_pool}) is None
    assert batch_prediction._feature_core_coverage_error(
        {batch_prediction.BATCH_CONTEXT_ERROR_KEY: "feature_context_failed:x", _BATCH_MODEL_POOL_KEY: r33_pool}
    ) == "feature_context_failed:x"


def test_r33_non_finite_score_drops_only_that_model():
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY, _BATCH_MODEL_POOL_KEY, predict_stock_v2
    from app.schemas import PredictRequest
    pool = _full_model_pool({"XGBoost": "active", "LightGBM": "active"})
    scores = {"LightGBM": 0.4, "XGBoost": float("nan")}

    def request(snapshot):
        return PredictRequest(**{**_predict_payload("2330", 2330, 100.0), "runtime_options": {
            _BATCH_FEATURE_RANK_SCORES_KEY: dict(scores), _BATCH_MODEL_POOL_KEY: snapshot}})
    with pytest.raises(ValueError, match="active8_base_score_non_finite:XGBoost"):
        predict_stock_v2(request(pool))
    out = predict_stock_v2(request({**pool, "active8_ensemble": {"kind": "r33_equal7_isotonic"}}))
    assert out["rank_scores"] == {"LightGBM": 0.4}
    assert out["model_errors"] == ["active8_base_score_non_finite:XGBoost"]


def test_r33_every_feature_model_non_finite_keeps_the_row_for_gnn_and_sequence():
    """NEW-1030-06 (A1 m-c): the controller builds a symbol's row only from its feature row, so a
    raise here dropped the GNN and sequence scores too. Under R33 the row survives with no
    feature score and names each model's gap; the controller's rank pool unscores it only when
    none of the seven scored. Other modes still fail the row."""
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY, _BATCH_MODEL_POOL_KEY, predict_stock_v2
    from app.schemas import PredictRequest
    pool = _full_model_pool({"LightGBM": "active", "ExtraTrees": "active", "TabM": "active"})
    r33_pool = {**pool, "active8_ensemble": {"kind": "r33_equal7_isotonic"}}

    def request(snapshot, scores, errors=()):
        return PredictRequest(**{**_predict_payload("2330", 2330, 100.0), "runtime_options": {
            _BATCH_FEATURE_RANK_SCORES_KEY: scores, _BATCH_MODEL_POOL_KEY: snapshot,
            "__batch_feature_model_errors": list(errors)}})
    nan = float("nan")
    out = predict_stock_v2(request(r33_pool, {"LightGBM": nan, "ExtraTrees": float("inf"), "TabM": nan}))
    assert out["rank_scores"] == {} and out["models"] == [] and "error" not in out
    assert out["model_errors"] == ["active8_base_score_non_finite:LightGBM", "active8_base_score_non_finite:ExtraTrees",
                                   "active8_base_score_non_finite:TabM"]
    gap = "ExtraTrees: r33_feature_input_non_finite:count=1:fields=pe"
    out = predict_stock_v2(request(r33_pool, {}, [gap]))
    assert out["rank_scores"] == {} and out["model_errors"] == [gap]
    with pytest.raises(ValueError, match="active8_feature_evidence_empty"):
        predict_stock_v2(request(pool, {}, [gap]))


class _NonFiniteRejectingModel(_Model):
    """sklearn 1.9 ExtraTrees raises on an inf anywhere in the batch, failing every symbol's score."""

    def predict(self, x_batch):
        if np.isinf(x_batch).any():
            raise ValueError("Input X contains infinity.")
        return super().predict(x_batch)


def _prep_contexts(rows, *, prep_only):
    from app.schemas import PredictRequest
    names = ["pe", "pb", "roe"]
    return [batch_prediction._FeatureBatchContext(
        req=PredictRequest(**_predict_payload(s, int(s), 100.0)), x_latest=np.asarray([row], dtype=float),
        feature_names=names, prep_only=prep_only) for s, row in rows]


def test_r33_non_finite_input_is_only_that_model_and_symbols_gap(monkeypatch):
    """NEW-1030-06: one symbol's non-finite prep input is that model's gap for that symbol, named
    by field and count; the batch's other symbols keep their scores and nothing is imputed."""
    rows = [("2330", [1.0, 2.0, 3.0]), ("2317", [np.nan, 2.0, np.inf]), ("2454", [1.5, 2.5, 3.5])]
    model = _NonFiniteRejectingModel([0.2, 0.7])
    contexts = _prep_contexts(rows, prep_only=True)
    batch_prediction._apply_artifact_batch_predictions(contexts, "ExtraTrees", model, {"feature_names": ["pe", "pb", "roe"]})
    assert model.calls == [(2, 3)]
    assert [c.rank_scores for c in contexts] == [{"ExtraTrees": 0.2}, {}, {"ExtraTrees": 0.7}]
    assert contexts[1].model_errors == ["ExtraTrees: r33_feature_input_non_finite:count=2:fields=pe,roe"]
    assert contexts[0].model_errors == contexts[2].model_errors == []


def test_outside_r33_a_non_finite_input_still_reaches_the_model(monkeypatch):
    model = _NonFiniteRejectingModel([0.2, 0.7, 0.9])
    contexts = _prep_contexts([("2330", [1.0, 2.0, 3.0]), ("2317", [np.inf, 2.0, 3.0])], prep_only=False)
    batch_prediction._apply_artifact_batch_predictions(contexts, "ExtraTrees", model, {"feature_names": ["pe", "pb", "roe"]})
    assert all(c.model_errors and "batch_contract_failed" in c.model_errors[0] for c in contexts)


def test_r33_non_finite_input_never_reaches_tabm_imputation(monkeypatch):
    """TabM's standardization zero-fills non-finite inputs; under R33 such a row is TabM's gap."""
    import types
    from app import tabm_batch_runtime
    seen = []
    artifact = types.SimpleNamespace(metadata={"feature_names": ["pe", "pb", "roe"]})
    monkeypatch.setattr(tabm_batch_runtime, "load_tabm_artifact", lambda pool=None: artifact)
    monkeypatch.setattr(batch_prediction, "_require_runtime_artifact_identity", lambda *a: None)
    monkeypatch.setattr(tabm_batch_runtime, "predict_tabm_scores",
                        lambda art, *, features: seen.append(features.copy()) or np.full(len(features), 0.4))
    contexts = _prep_contexts([("2330", [1.0, 2.0, 3.0]), ("2317", [1.0, np.nan, 3.0])], prep_only=True)
    batch_prediction._apply_tabm_torch_batch_predictions(contexts, {}, {"TabM": "active"})
    assert len(seen) == 1 and seen[0].shape == (1, 3) and np.isfinite(seen[0]).all()
    assert contexts[0].rank_scores == {"TabM": pytest.approx(0.4)} and contexts[1].rank_scores == {}
    assert contexts[1].model_errors == ["TabM: r33_feature_input_non_finite:count=1:fields=pb"]


def test_r33_non_finite_input_names_fields_by_position_without_matching_names():
    ctx = _prep_contexts([("2330", [1.0, np.nan, 3.0])], prep_only=True)[0]
    with pytest.raises(ValueError, match="count=1:fields=pb$"):
        batch_prediction._require_finite_r33_input(ctx, ctx.x_latest, {"feature_names": ["only_one"]})
    ctx.feature_names = ["a"]
    with pytest.raises(ValueError, match="count=1:fields=#1$"):
        batch_prediction._require_finite_r33_input(ctx, ctx.x_latest, None)
