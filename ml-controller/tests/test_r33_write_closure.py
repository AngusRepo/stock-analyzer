"""R33 end to end after the callback (Wei 10/29): one name's Modal row error is that name
unscored (prediction_missing) and a held name outside the seed is expected, so the
write node's universe closure passes; one model missing is z=0 for that model only;
the day's per-model coverage goes to ops system_logs. Structural gaps still fail."""
import asyncio
import logging
from copy import deepcopy

import pytest

from graphs import daily_pipeline_v2 as pipeline
from services import r33_rank_pool as rank_pool
from services.r33_calibration_job import POOL_SOURCE
from services.r33_isotonic_calibration import MODELS
from services.r33_serving_inputs import COVERAGE_LOG_CRON, coverage_log, write_coverage_log
from test_r33_l4_equal7 import DAY, IDENTITY, POOL, _ensemble, _prediction

RECEIPT = {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "r", "membership_sha256": "p" * 64}


def _pool(predictions, holdings=()):
    return rank_pool.build_rank_pool(signal_date=DAY, pool=(POOL, RECEIPT), predictions=predictions,
                                     holdings=list(holdings), ensemble=_ensemble(), l3_identity=IDENTITY)


def _state(monkeypatch, predictions, *, snapshot, holdings=()):
    seeds = [{"symbol": s, "id": i + 1} for i, s in enumerate(POOL)]
    held = [{"symbol": h, "id": 100 + i, "eligible_for_pending_buy": False} for i, h in enumerate(holdings)]
    for name in ("prune_predictions_outside_universe", "write_predictions_to_d1", "write_layer3_formal_gate_audit",
                 "update_recommendations_in_d1", "re_rank_recommendations"):
        monkeypatch.setattr(pipeline, name, lambda *a, **k: 0)
    final = [s for s in deepcopy(seeds) if s["symbol"] in predictions]
    monkeypatch.setattr(pipeline, "update_recommendations_in_d1", lambda rows, day: len(rows))
    monkeypatch.setattr(pipeline, "delete_filtered_recommendations", lambda symbols, day, **kw: len(symbols))
    monkeypatch.setattr(pipeline, "assert_canonical_window_open", lambda *a, **kw: None)
    return {"run_date": DAY, "active_stocks": [*deepcopy(seeds), *held], "screener_recs": seeds,
            "r33_holdings": list(holdings), "predictions": predictions, "r33_rank_pool": snapshot,
            "final_recommendations": final, "sell_filtered_symbols": [s for s in POOL if s not in predictions],
            "active8_action_authority": {}}


def _predictions(missing=()):
    return {s: _prediction(0.1 * i) for i, s in enumerate(POOL) if s not in missing}


def test_a_row_error_name_is_unscored_and_the_day_closes():
    predictions = _predictions(missing=("P3",))     # Modal row error: never reaches pred_map
    snapshot = _pool(predictions)
    assert snapshot["coverage"]["unscored"] == {"P3": "prediction_missing"}


def test_write_node_accepts_an_unscored_seed_and_a_holding_outside_the_seed(monkeypatch):
    predictions = {**_predictions(missing=("P3",)), "H7": _prediction(0.3)}
    state = _state(monkeypatch, predictions, snapshot=_pool(predictions, holdings=("H7",)), holdings=("H7",))
    out = asyncio.run(pipeline.node_write_d1(state))
    metrics = out.get("write_metrics") or out.get("metrics") or out
    text = repr(metrics)
    assert "'r33_unscored_missing_prediction_symbols': ['P3']" in text
    assert "'missing_prediction_symbols': []" in text


def test_without_the_rank_pool_a_missing_seed_still_fails_the_day(monkeypatch):
    predictions = _predictions(missing=("P3",))
    state = _state(monkeypatch, predictions, snapshot=None)
    with pytest.raises(RuntimeError, match=r'prediction_universe_closure_failed.*"missing": \["P3"\]'):
        asyncio.run(pipeline.node_write_d1(state))


def test_without_the_rank_pool_a_holding_outside_the_seed_still_fails(monkeypatch):
    predictions = {**_predictions(), "H7": _prediction(0.3)}
    state = _state(monkeypatch, predictions, snapshot=None, holdings=("H7",))
    with pytest.raises(RuntimeError, match=r'prediction_universe_closure_failed.*"foreign_stock_map": \["H7"\]'):
        asyncio.run(pipeline.node_write_d1(state))


def test_a_seed_the_pool_does_not_know_still_fails(monkeypatch):
    predictions = _predictions()
    state = _state(monkeypatch, predictions, snapshot=_pool(predictions))
    state["screener_recs"] = [*state["screener_recs"], {"symbol": "X9", "id": 99}]
    state["active_stocks"] = [*state["active_stocks"], {"symbol": "X9", "id": 99}]
    with pytest.raises(RuntimeError, match=r'"missing": \["X9"\]'):
        asyncio.run(pipeline.node_write_d1(state))


def test_an_unattested_rank_pool_is_not_trusted_for_the_closure(monkeypatch):
    predictions = _predictions(missing=("P3",))
    snapshot = _pool(predictions)
    snapshot["coverage"]["unscored"]["P4"] = "prediction_missing"
    state = _state(monkeypatch, predictions, snapshot=snapshot)
    with pytest.raises(ValueError, match="r33_rank_pool_checksum_invalid"):
        asyncio.run(pipeline.node_write_d1(state))


def test_one_model_missing_is_z0_for_that_model_and_the_whole_row_missing_is_unscored():
    predictions = _predictions(missing=("P6",))
    del predictions["P2"]["model_score_lineage"]["raw_scores"]["TabM"]
    snapshot = _pool(predictions)
    rows = {r["symbol"]: r for r in snapshot["rows"]}
    assert rows["P2"]["available"]["TabM"] is False and rows["P2"]["z"]["TabM"] == 0.0
    assert all(rows["P2"]["available"][m] for m in MODELS if m != "TabM")
    assert rows["P2"]["expected_excess"] is not None and rows["P2"]["unscored_reason"] is None
    assert rows["P6"]["unscored_reason"] == "prediction_missing" and rows["P6"]["score"] is None


def test_coverage_log_counts_gaps_per_model_and_warns_on_a_full_outage():
    predictions = _predictions(missing=("P6",))
    for p in predictions.values():
        del p["model_score_lineage"]["raw_scores"]["ExtraTrees"]
    level, message, meta = coverage_log(_pool(predictions), row_errors={"P6": "feature_context_failed:ValueError:x"})
    assert level == "warn"
    assert meta["by_model"]["ExtraTrees"] == {"missing": 6, "total": 6}
    assert meta["by_model"]["LightGBM"] == {"missing": 1, "total": 6}
    assert meta["models_fully_missing"] == ["ExtraTrees"] and "ExtraTrees" in message
    assert meta["unscored_by_reason"] == {"prediction_missing": 1}
    assert meta["row_errors"] == {"P6": "feature_context_failed:ValueError:x"}


def test_full_coverage_is_an_info_line():
    level, _message, meta = coverage_log(_pool(_predictions()), row_errors={})
    assert level == "info" and meta["models_with_gaps"] == [] and meta["models_fully_missing"] == []


def test_coverage_log_writes_ops_system_logs_and_a_failed_write_never_fails(caplog):
    calls = []
    snapshot = _pool(_predictions(missing=("P1",)))
    with caplog.at_level(logging.WARNING):
        write_coverage_log(lambda sql, params: calls.append((sql, params)), snapshot, row_errors={},
                           logger=logging.getLogger("t"))
    assert len(calls) == 1 and "INSERT INTO system_logs" in calls[0][0]
    assert calls[0][1][:2] == ["warn", COVERAGE_LOG_CRON]
    assert any("[R33 coverage]" in r.message for r in caplog.records)

    def boom(sql, params):
        raise RuntimeError("d1 down")
    write_coverage_log(boom, snapshot, row_errors={}, logger=logging.getLogger("t"))


def _terminal_count_blockers(monkeypatch, predictions, holdings=()):
    state = _state(monkeypatch, predictions, snapshot=_pool(predictions, holdings=holdings), holdings=holdings)
    metrics = asyncio.run(pipeline.node_write_d1(state))["metrics"]
    return metrics, [b for b in pipeline.classify_pipeline_terminal_invariants(metrics)
                     if "prediction_symbol" in b]


@pytest.mark.parametrize(("missing", "holdings"), [(("P3",), ()), ((), ("H7",)), (("P3",), ("H7",))])
def test_terminal_invariant_closes_the_seed_with_unscored_and_held_names(monkeypatch, missing, holdings):
    predictions = {**_predictions(missing=missing), **{h: _prediction(0.3) for h in holdings}}
    metrics, blockers = _terminal_count_blockers(monkeypatch, predictions, holdings)
    assert blockers == []
    assert metrics["prediction_symbols"] == len(POOL) - len(missing)
    assert metrics["r33_unscored_missing_prediction_count"] == len(missing)
    assert metrics["r33_held_outside_seed_prediction_symbols"] == len(holdings)


def test_terminal_invariant_without_r33_counts_are_unchanged():
    base = {"prediction_seed_symbols": 6, "prediction_symbols": 5}
    assert any("prediction_symbol_count_mismatch:actual=5:expected=6" in b
               for b in pipeline.classify_pipeline_terminal_invariants(base))
    closed = {**base, "r33_unscored_missing_prediction_count": 1}
    assert not any("count_mismatch" in b for b in pipeline.classify_pipeline_terminal_invariants(closed))


def test_write_node_rejects_prediction_evidence_drift(monkeypatch):
    predictions = _predictions(missing=("P3",))
    snapshot = _pool(predictions)
    predictions["P1"]["r33_rank_evidence"] = dict(predictions["P1"]["r33_rank_evidence"], score=9.0)
    state = _state(monkeypatch, predictions, snapshot=snapshot)
    with pytest.raises(ValueError, match="r33_rank_pool_evidence_mismatch:P1"):
        asyncio.run(pipeline.node_write_d1(state))


def test_node_inputs_write_one_coverage_line_with_row_errors(monkeypatch):
    import json
    from services import paired_nav_collection
    monkeypatch.setattr(rank_pool, "load_serving_pool", lambda query, **kw: (list(POOL), {**RECEIPT, "screener_run_id": "run-1"}))
    monkeypatch.setattr(paired_nav_collection, "baseline_model_identity", lambda manifest: dict(IDENTITY))
    calls = []
    pipeline._r33_serving_inputs(
        {"screener_run_id": "run-1", "r33_holdings": [], "trading_config": {"fees": {"commission": 0.001425, "tax": 0.003}}},
        payloads=[{"symbol": s, "prices": [{"date": DAY}]} for s in POOL], predictions=_predictions(missing=("P3",)),
        ensemble=_ensemble(), serving_manifest={}, run_date=DAY, evidence_only=False, ops_query=None,
        row_errors={"P3": "feature_context_failed:" + "x" * 900}, ops_execute=lambda sql, params: calls.append(params))
    assert len(calls) == 1 and calls[0][0] == "warn"
    assert json.loads(calls[0][3])["row_errors"]["P3"] == ("feature_context_failed:" + "x" * 900)[:500]


def test_a_stale_seed_with_a_prediction_is_counted_once(monkeypatch):
    predictions = _predictions(missing=("P3",))
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=(POOL, RECEIPT), predictions=predictions, holdings=[],
                                         ensemble=_ensemble(), l3_identity=IDENTITY, stale={"P6": "last_bar=2026-11-07"})
    state = _state(monkeypatch, predictions, snapshot=snapshot)
    metrics = asyncio.run(pipeline.node_write_d1(state))["metrics"]
    assert metrics["prediction_symbols"] == 5 and metrics["r33_unscored_missing_prediction_count"] == 1
    assert not [b for b in pipeline.classify_pipeline_terminal_invariants(metrics) if "prediction_symbol" in b]


def test_held_names_outside_the_seed_stay_out_of_the_l3_model_closure(monkeypatch):
    predictions = {**_predictions(), "H7": _prediction(0.3)}
    for symbol in POOL:
        predictions[symbol]["core_family_evidence"] = {"formal_model_contract_passed": True}
    state = _state(monkeypatch, predictions, snapshot=_pool(predictions, holdings=("H7",)), holdings=("H7",))
    state.pop("layer2_recommendation_symbols", None)
    metrics = asyncio.run(pipeline.node_write_d1(state))["metrics"]
    assert metrics["incomplete_active_model_symbols"] == 0 and metrics["formal_evidence_prediction_symbols"] == len(POOL)
