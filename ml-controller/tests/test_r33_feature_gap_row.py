"""NEW-1030-06 (A1 m-c): a symbol whose three feature models are all non-finite keeps its GNN and
sequence scores under R33. node_ml_predict builds a name's row only from its feature row, so a
feature row error drops every model for the name (prediction_missing); the ml-service row now
survives with no feature score and each feature model's gap named in model_errors, and the
day's coverage line counts those gaps per model and reason."""
import asyncio
import json

import pytest

from graphs import daily_pipeline_v2 as P
from services.r33_serving_inputs import coverage_log
from test_r33_node_day_outage import SYMBOLS, r33_day  # noqa: F401 - fixture

GAPS = ["active8_base_score_non_finite:LightGBM", "ExtraTrees: r33_feature_input_non_finite:count=2:fields=pe,roe",
        "active8_base_score_non_finite:TabM", "XGBoost: skipped by model_pool status=retired"]


def _run_to_coverage(state, monkeypatch):
    def stop(*a, **k):
        raise RuntimeError("past the coverage check")
    monkeypatch.setattr(P, "_attach_formal_ensemble", stop)
    with pytest.raises(RuntimeError, match="past the coverage check"):
        asyncio.run(P.node_ml_predict(state))


def test_a_feature_row_error_drops_the_names_gnn_and_sequence_scores(r33_day, monkeypatch):
    """The old ml-service raise: the whole name is prediction_missing, GNN and sequences included."""
    state, logged = r33_day
    state["modal_prediction_bundle"]["predict_batch_v2_results"][0] = {
        "symbol": SYMBOLS[0], "error": "ValueError: active8_feature_evidence_empty"}
    _run_to_coverage(state, monkeypatch)
    meta = json.loads(logged[0][3])
    assert meta["unscored_by_reason"] == {"prediction_missing": 1}
    assert {m: v["missing"] for m, v in meta["by_model"].items()} == dict.fromkeys(meta["by_model"], 1)


def test_all_three_feature_models_non_finite_keeps_the_other_four(r33_day, monkeypatch):
    state, logged = r33_day
    state["modal_prediction_bundle"]["predict_batch_v2_results"][0] = {
        "symbol": SYMBOLS[0], "rank_scores": {}, "model_errors": list(GAPS)}
    _run_to_coverage(state, monkeypatch)
    assert len(logged) == 1 and logged[0][0] == "warn"
    meta = json.loads(logged[0][3])
    assert meta["unscored_by_reason"] == {} and meta["pool_scored_rows"] == len(SYMBOLS)
    assert {m: v["missing"] for m, v in meta["by_model"].items()} == {
        "LightGBM": 1, "ExtraTrees": 1, "TabM": 1, "GNN": 0, "TimeXer": 0, "PatchTST": 0, "iTransformer": 0}
    assert meta["model_errors_by_model"] == {"ExtraTrees": {"r33_feature_input_non_finite": 1},
                                             "LightGBM": {"active8_base_score_non_finite": 1},
                                             "TabM": {"active8_base_score_non_finite": 1}}
    assert meta["model_error_names"] == 1 and meta["model_errors_sample"] == {SYMBOLS[0]: "; ".join(GAPS[:3])}
    assert "model errors on 1 names" in logged[0][2]


def test_a_name_no_model_scored_is_still_unscored(r33_day, monkeypatch):
    state, logged = r33_day
    bundle = state["modal_prediction_bundle"]
    bundle["predict_batch_v2_results"][0] = {"symbol": SYMBOLS[0], "rank_scores": {}, "model_errors": list(GAPS)}
    for field in ("gnn_graphsage_raw", "timexer_raw", "patchtst_raw", "itransformer_raw"):
        rows = bundle[field]["results"]
        rows[:] = [r if r["symbol"] != SYMBOLS[0] else {"symbol": SYMBOLS[0], "error": "x"} for r in rows]
    _run_to_coverage(state, monkeypatch)
    meta = json.loads(logged[0][3])
    assert meta["unscored_by_reason"] == {"no_model_available": 1}


def test_coverage_line_ignores_models_outside_the_seven_and_is_info_without_gaps():
    pool = {"signal_date": "2026-09-09", "screener_run_id": "r", "uninformative_models": [],
            "coverage": {"pool_rows": 2, "pool_scored_rows": 2, "unscored": {},
                         "by_model": dict.fromkeys(["LightGBM", "ExtraTrees", "TabM", "GNN", "TimeXer", "PatchTST",
                                                    "iTransformer"], 2)}}
    level, _message, meta = coverage_log(pool, row_errors={}, model_errors={"2330": [GAPS[3]]})
    assert level == "info" and meta["model_errors_by_model"] == {} and meta["model_errors_sample"] == {}
    # A held name outside the pool leaves no pool gap; its feature model error still warns.
    level, _message, meta = coverage_log(pool, row_errors={}, model_errors={"9999": [GAPS[0]]})
    assert level == "warn" and meta["model_errors_by_model"] == {"LightGBM": {"active8_base_score_non_finite": 1}}


def test_the_per_name_text_is_a_sample_and_the_counts_cover_every_name():
    from services.r33_serving_inputs import MODEL_ERROR_SAMPLE
    pool = {"signal_date": "2026-09-09", "screener_run_id": "r", "uninformative_models": [],
            "coverage": {"pool_rows": 1, "pool_scored_rows": 1, "unscored": {},
                         "by_model": dict.fromkeys(["LightGBM", "ExtraTrees", "TabM", "GNN", "TimeXer", "PatchTST",
                                                    "iTransformer"], 1)}}
    errors = {f"{i:04d}": [GAPS[0]] for i in range(MODEL_ERROR_SAMPLE + 5)}
    _level, _message, meta = coverage_log(pool, row_errors={}, model_errors=errors)
    assert meta["model_error_names"] == MODEL_ERROR_SAMPLE + 5 and len(meta["model_errors_sample"]) == MODEL_ERROR_SAMPLE
    assert meta["model_errors_by_model"] == {"LightGBM": {"active8_base_score_non_finite": MODEL_ERROR_SAMPLE + 5}}


def test_a_whole_day_feature_outage_still_aborts_the_day(r33_day):
    """Every name keeps its GNN and sequence scores now, so the abort comes from the coverage
    check (m-d), after the error ops line, instead of an empty rank pool."""
    state, logged = r33_day
    state["modal_prediction_bundle"]["predict_batch_v2_results"] = [
        {"symbol": s, "rank_scores": {}, "model_errors": list(GAPS)} for s in SYMBOLS]
    with pytest.raises(RuntimeError, match="^r33_model_missing_for_day:ExtraTrees,LightGBM,TabM$"):
        asyncio.run(P.node_ml_predict(state))
    assert len(logged) == 1 and logged[0][0] == "error"
