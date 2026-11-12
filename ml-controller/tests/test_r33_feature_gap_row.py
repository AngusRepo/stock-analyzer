"""NEW-1030-06 (A1 m-c): under R33 a name keeps its GNN and sequence scores when its feature models
fail. The ml-service row survives non-finite feature inputs or scores with each gap named in
model_errors; when the Modal feature row itself fails or never comes back, node_ml_predict builds
a skeleton row from the payload with the row error charged to each feature model. The day's
coverage line counts gaps per model and reason; per-name text is a sample."""
import asyncio
import json

import pytest

from graphs import daily_pipeline_v2 as P
from services.r33_serving_inputs import coverage_log
from test_r33_node_day_outage import SYMBOLS, r33_day  # noqa: F401 - fixture
from test_pipeline_frozen_sequence_membership import dispatched  # noqa: F401 - the legacy (non-R33) day

GAPS = ["active8_base_score_non_finite:LightGBM", "ExtraTrees: r33_feature_input_non_finite:count=2:fields=pe,roe",
        "active8_base_score_non_finite:TabM", "XGBoost: skipped by model_pool status=retired"]


def _run_to_coverage(state, monkeypatch):
    def stop(*a, **k):
        raise RuntimeError("past the coverage check")
    monkeypatch.setattr(P, "_attach_formal_ensemble", stop)
    with pytest.raises(RuntimeError, match="past the coverage check"):
        asyncio.run(P.node_ml_predict(state))


ROW_ERRORS = [
    # (Modal row, reason code each feature model is charged with)
    ({"error": "ValueError: active8_feature_evidence_empty"}, "active8_feature_evidence_empty"),
    ({"error": "RuntimeError: feature_context_failed:ValueError:could not convert"}, "feature_context_failed"),
    ({"error": "RuntimeError: feature_context_failed:ValueError:r33_prep_row_missing:v1"},
     "feature_context_failed.r33_prep_row_missing"),
    ({"error": "RuntimeError: batch_override_build_failed:KeyError:'pool'"}, "batch_override_build_failed"),
    ({"error": "KeyError: 'close'"}, "KeyError"),
    ({"error": "predict_batch_v2 chunk error: TimeoutError: modal"}, "predict_batch_v2 chunk error"),
    (None, "feature_row_absent"),
]


@pytest.mark.parametrize("modal_row,code", ROW_ERRORS)
def test_a_feature_row_error_keeps_the_names_gnn_and_sequence_scores(r33_day, monkeypatch, modal_row, code):
    """Context, prep-row, override, chunk and finalize failures and an absent row all cost the
    name its three feature models only; the error is charged to each by code, nothing is filled."""
    state, logged = r33_day
    rows = state["modal_prediction_bundle"]["predict_batch_v2_results"]
    if modal_row is None:
        rows.pop(0)
    else:
        rows[0] = {"symbol": SYMBOLS[0], **modal_row}
    _run_to_coverage(state, monkeypatch)
    meta = json.loads(logged[0][3])
    assert logged[0][0] == "warn" and meta["unscored_by_reason"] == {} and meta["pool_scored_rows"] == len(SYMBOLS)
    assert {m: v["missing"] for m, v in meta["by_model"].items()} == {
        "LightGBM": 1, "ExtraTrees": 1, "TabM": 1, "GNN": 0, "TimeXer": 0, "PatchTST": 0, "iTransformer": 0}
    assert meta["model_errors_by_model"] == {m: {code: 1} for m in ("ExtraTrees", "LightGBM", "TabM")}
    assert meta["row_error_names"] == (0 if modal_row is None else 1)
    assert meta["row_errors_by_reason"] == ({} if modal_row is None else {code: 1})


def test_a_feature_gap_row_runs_through_the_ensemble_and_the_d1_writer(r33_day, monkeypatch):
    from services import recommendation_service as R
    state, _logged = r33_day
    rows = state["modal_prediction_bundle"]["predict_batch_v2_results"]
    for r in rows:
        r["feature_version"] = "formal137:137"
    rows[0] = {"symbol": SYMBOLS[0], "error": "RuntimeError: feature_context_failed:ValueError:x"}
    predictions = asyncio.run(P.node_ml_predict(state))["predictions"]
    row = predictions[SYMBOLS[0]]
    assert set(row["rank_scores"]) == {"GNN", "TimeXer", "PatchTST", "iTransformer"}
    assert row["model_errors"] == [f"{m}: feature_context_failed" for m in ("LightGBM", "ExtraTrees", "TabM")]
    assert row["feature_row_error"] == "RuntimeError: feature_context_failed:ValueError:x"
    evidence = row["r33_rank_evidence"]
    assert evidence["unscored_reason"] is None and evidence["score"] is not None
    assert {m for m, ok in evidence["available"].items() if not ok} == {"LightGBM", "ExtraTrees", "TabM"}
    assert row["ensemble_v2"]["schema_version"] == "r33-equal7-runtime-v1"
    assert row["current_price"] == 100.0 and row["stock_meta"] == {"market_segment": "LISTED"}
    assert row["feature_version"] == "formal137:0" and row["feature_count"] == 0
    # The real prediction writer accepts the row: the ensemble line and one line per scoring model.
    statements = []
    monkeypatch.setattr(R, "_predictions_batch_execute", lambda batch: statements.extend(batch))
    monkeypatch.setattr(R, "_predictions_query", lambda *a, **k: [])
    assert R.write_predictions_to_d1({SYMBOLS[0]: row}, {SYMBOLS[0]: 1}, state["run_date"]) > 0
    assert statements


def test_a_gap_row_without_one_day_feature_schema_fails_closed_at_the_writer(r33_day, monkeypatch):
    from services import recommendation_service as R
    state, _logged = r33_day
    rows = state["modal_prediction_bundle"]["predict_batch_v2_results"]
    for i, r in enumerate(rows):
        r["feature_version"] = f"formal13{i % 2}:137"
    rows[0] = {"symbol": SYMBOLS[0], "error": "RuntimeError: feature_context_failed:ValueError:x"}
    row = asyncio.run(P.node_ml_predict(state))["predictions"][SYMBOLS[0]]
    assert row["feature_version"] is None
    monkeypatch.setattr(R, "_predictions_batch_execute", lambda batch: None)
    monkeypatch.setattr(R, "_predictions_query", lambda *a, **k: [])
    with pytest.raises(ValueError, match="^missing_feature_version_contract"):
        R.write_predictions_to_d1({SYMBOLS[0]: row}, {SYMBOLS[0]: 1}, state["run_date"])


def test_a_feature_row_error_and_no_other_model_is_unscored(r33_day, monkeypatch):
    state, logged = r33_day
    bundle = state["modal_prediction_bundle"]
    bundle["predict_batch_v2_results"][0] = {"symbol": SYMBOLS[0], "error": "RuntimeError: feature_context_failed:x"}
    for field in ("gnn_graphsage_raw", "timexer_raw", "patchtst_raw", "itransformer_raw"):
        rows = bundle[field]["results"]
        rows[:] = [r if r["symbol"] != SYMBOLS[0] else {"symbol": SYMBOLS[0], "error": "x"} for r in rows]
    _run_to_coverage(state, monkeypatch)
    meta = json.loads(logged[0][3])
    assert meta["unscored_by_reason"] == {"no_model_available": 1}
    assert meta["row_errors"] == {SYMBOLS[0]: "RuntimeError: feature_context_failed:x"}


def test_a_whole_day_of_feature_row_errors_aborts_on_the_feature_models(r33_day):
    state, logged = r33_day
    state["modal_prediction_bundle"]["predict_batch_v2_results"] = [
        {"symbol": s, "error": "predict_batch_v2 chunk error: TimeoutError: modal"} for s in SYMBOLS]
    with pytest.raises(RuntimeError, match="^r33_model_missing_for_day:ExtraTrees,LightGBM,TabM$"):
        asyncio.run(P.node_ml_predict(state))
    assert len(logged) == 1 and logged[0][0] == "error"
    assert json.loads(logged[0][3])["row_errors_by_reason"] == {"predict_batch_v2 chunk error": len(SYMBOLS)}


def test_outside_r33_a_feature_row_error_still_drops_the_name(dispatched, monkeypatch):
    from services import cost_tracker

    async def no_cost(*a, **k):
        return None
    monkeypatch.setattr(cost_tracker, "record_compute_profile_event", no_cost)
    state, _request, bundle = dispatched
    bundle["predict_batch_v2_results"][0] = {"symbol": "2330", "error": "RuntimeError: feature_context_failed:x"}
    state["modal_prediction_bundle"] = bundle
    predictions = asyncio.run(P.node_ml_predict(state, research_only=True))["predictions"]
    assert "2330" not in predictions and len(predictions) == len(state["payloads"]) - 1


def test_gap_row_names_no_price_it_cannot_read():
    from services.r33_serving_inputs import feature_gap_row
    for prices in ([], [{"date": "d"}], [{"close": "n/a"}], [{"close": float("nan")}], [{"close": 0}]):
        row = feature_gap_row({"symbol": "1101", "prices": prices}, None, ("LightGBM",), feature_schema="formal137")
        assert row["current_price"] is None and row["entry_price"] is None
    row = feature_gap_row({"symbol": "1101", "prices": [{"adj_close": 41.5}]}, "", ("LightGBM", "TabM"), feature_schema=None)
    assert row["current_price"] == 41.5 and row["rank_scores"] == {} and row["feature_version"] is None
    assert row["model_errors"] == ["LightGBM: feature_row_absent", "TabM: feature_row_absent"]
    # close first, as ml-service close_price reads it
    row = feature_gap_row({"symbol": "1101", "prices": [{"close": 50.0, "adj_close": 40.0}]}, "", ("TabM",), feature_schema="f")
    assert row["current_price"] == 50.0 and row["feature_version"] == "f:0"


@pytest.mark.parametrize("text,code", [
    ("feature_context_failed:ValueError:x", "feature_context_failed"),
    ("feature_context_failed:ValueError:r33_prep_row_missing:v1", "feature_context_failed.r33_prep_row_missing"),
    ("RuntimeError: active_feature_model_coverage_incomplete:missing_or_invalid=TabM", "active_feature_model_coverage_incomplete"),
    ("RuntimeError: feature_context_failed:ValueError:r33_prep_view_failed:v2:boom", "feature_context_failed.r33_prep_view_failed"),
    ("RuntimeError: feature_context_failed:ValueError:Feature matrix empty", "feature_context_failed"),
    ("KeyError: 'close'", "KeyError"),
    ("predict_batch_v2 returned invalid payload", "predict_batch_v2 returned invalid payload"),
    ("", "unknown_error"),
])
def test_row_error_code(text, code):
    from services.r33_serving_inputs import row_error_code
    assert row_error_code(text) == code


def test_row_errors_in_the_line_are_a_sample_and_counted_by_reason():
    from services.r33_serving_inputs import MODEL_ERROR_SAMPLE
    pool = {"signal_date": "2026-09-09", "screener_run_id": "r", "uninformative_models": [],
            "coverage": {"pool_rows": 1, "pool_scored_rows": 1, "unscored": {},
                         "by_model": dict.fromkeys(["LightGBM", "ExtraTrees", "TabM", "GNN", "TimeXer", "PatchTST",
                                                    "iTransformer"], 1)}}
    errors = {f"{i:04d}": "RuntimeError: feature_context_failed:" + "x" * 900 for i in range(MODEL_ERROR_SAMPLE + 5)}
    errors["9999"] = "KeyError: 'close'"
    level, message, meta = coverage_log(pool, row_errors=errors)
    assert level == "warn" and "Modal row errors 26" in message
    assert meta["row_error_names"] == MODEL_ERROR_SAMPLE + 6 and len(meta["row_errors"]) == MODEL_ERROR_SAMPLE
    assert all(len(v) == 500 for v in meta["row_errors"].values())
    assert meta["row_errors_by_reason"] == {"KeyError": 1, "feature_context_failed": MODEL_ERROR_SAMPLE + 5}


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
