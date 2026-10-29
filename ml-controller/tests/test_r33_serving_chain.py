"""R33 serving chain on fixtures: rank pool -> ensemble_v2 (LV5#2) -> recommendations -> L3 coverage (R4) -> L4."""
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from services import recommendation_service as reco
from services import r33_ensemble
from services import r33_rank_pool as rank_pool
from services.ensemble_v2 import attach_ensemble_v2, build_formal_model_input_contract, validate_active8_ensemble_artifact
from services.l4_distribution_runtime import run
from services.r33_calibration_job import POOL_SOURCE
from services.r33_isotonic_calibration import MODELS
from test_r33_l4_equal7 import DAY, IDENTITY, POOL, _ensemble, _prediction, fixture
from test_recommendation_provenance import _payload, _screener_rec

FEES = {"commission": 0.001425, "tax": 0.003}
COST = r33_ensemble.round_trip_cost(FEES)
POOL_MODELS = {m: {"serving_artifact_id": f"{m}:c1", "version": m + "-v1", "checksum": "sha256:" + "a" * 64,
                   "serving_eligible": True} for m in MODELS}


def _chain(stale=None, extra=None):
    predictions = {s: _prediction(v) for s, v in zip(POOL, (-0.5, -0.1, 0.2, 0.6, 1.0, 1.4))}
    predictions.update(extra or {})
    receipt = {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "run-1", "membership_sha256": "p" * 64}
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=(POOL, receipt), predictions=predictions, holdings=[],
                                         ensemble=_ensemble(), l3_identity=IDENTITY, stale=stale)
    for prediction in predictions.values():
        attach_ensemble_v2(prediction, _ensemble(), POOL_MODELS, round_trip_cost=COST)
    return predictions, snapshot


def test_round_trip_cost_is_entry_plus_exit_from_the_fees_owner():
    assert COST == pytest.approx(0.00585)
    with pytest.raises(ValueError, match="r33_round_trip_cost_invalid"):
        r33_ensemble.round_trip_cost({"commission": 0, "tax": 0})


def test_signal_is_ehat_against_cost_and_unscored_is_no_signal():
    predictions, snapshot = _chain(stale={"P6": "last_bar=2026-11-07"}, extra={"X9": _prediction(0.3)})
    for symbol, prediction in predictions.items():
        ev2 = prediction["ensemble_v2"]
        ehat = (prediction.get(rank_pool.EVIDENCE_KEY) or {}).get("expected_excess")
        expected = ("NO_SIGNAL" if ehat is None else "BUY" if ehat > COST else "SELL" if ehat <= 0 else "HOLD")
        assert ev2["signal"] == expected, symbol
        assert ev2["forecast_pct"] == ehat and ev2["probability_positive_net_return"] is None
        assert ev2["confidence"] == 0.0 and ev2["weights"] == {m: round(1 / 7, 8) for m in MODELS}
        assert ev2["artifact_checksum"] == IDENTITY["payload_checksum"]
    assert {s for s, p in predictions.items() if p["ensemble_v2"]["signal"] == "NO_SIGNAL"} == {"P6", "X9"}
    assert predictions["X9"]["ensemble_v2"]["formal_model_input_contract"]["r33_unscored_reason"] == "r33_rank_pool_missing"
    assert predictions["P6"]["ensemble_v2"]["formal_model_input_contract"]["r33_unscored_reason"] == \
        "r33_unscored:stale:last_bar=2026-11-07"
    assert rank_pool.validate_rank_pool(snapshot, predictions) is snapshot
    signals = {p["ensemble_v2"]["signal"] for p in predictions.values()}
    assert {"BUY", "SELL"} <= signals            # the fixture table reaches both sides


def test_r33_ensemble_validates_whole_and_matches_serving_pool():
    validate_active8_ensemble_artifact(_ensemble(), POOL_MODELS)
    other = deepcopy(POOL_MODELS)
    other["GNN"]["version"] = "GNN-v0"
    with pytest.raises(RuntimeError, match="active8_ensemble_base_identity_mismatch:GNN"):
        validate_active8_ensemble_artifact(_ensemble(), other)
    with pytest.raises(RuntimeError, match="r33_ensemble_nav_inference_unsupported"):
        validate_active8_ensemble_artifact(_ensemble(), POOL_MODELS, nav_authority=object())
    with pytest.raises(ValueError, match="r33_round_trip_cost_invalid"):
        attach_ensemble_v2(_prediction(0.1), _ensemble(), POOL_MODELS)


def test_evidence_from_another_calibration_is_rejected():
    predictions, _ = _chain()
    prediction = deepcopy(predictions["P1"])
    prediction[rank_pool.EVIDENCE_KEY]["calibration_checksum"] = "0" * 64
    with pytest.raises(ValueError, match="r33_rank_evidence_calibration_mismatch"):
        attach_ensemble_v2(prediction, _ensemble(), POOL_MODELS, round_trip_cost=COST)


def test_formal_contract_never_drops_an_r33_row():
    predictions, _ = _chain(stale={"P6": "no_bars"})
    for prediction in predictions.values():
        contract = build_formal_model_input_contract(prediction)
        assert contract["complete"] is True and contract["required_models"] == []
    assert build_formal_model_input_contract(predictions["P6"])["r33_scored"] is False


def test_recommendations_keep_unscored_names_as_coverage_and_l4_marks_them_unavailable():
    predictions, snapshot = _chain(stale={"P6": "last_bar=2026-11-07"})
    recs = [{**_screener_rec(s), "date": DAY} for s in POOL]
    rows, removed = reco.filter_and_score_recommendations(recs, predictions, [_payload(s) for s in POOL])
    assert removed == 0 and {r["symbol"] for r in rows} == set(POOL)
    by_symbol = {r["symbol"]: r for r in rows}
    assert by_symbol["P6"]["ml_score"] == 0.0 and by_symbol["P6"]["signal"] == "NO_SIGNAL"
    assert by_symbol["P6"]["ml_edge_policy"] is None
    edge = by_symbol["P5"]["ml_edge_policy"]
    assert edge["schema_version"] == "score-v2-ml-edge-r33-ehat-range-position-v1"
    assert by_symbol["P5"]["ml_score"] == pytest.approx(round(30 * predictions["P5"]["ensemble_v2"]["ehat_range_position"], 1))
    rows = reco.apply_core_family_evidence(rows, predictions, require_lifecycle_weights=True,
                                           require_complete_active_models=True)
    assert {r["symbol"] for r in rows} == set(POOL)          # R4: no L3 drop
    _, policy, history = fixture(stale={"P6": "last_bar=2026-11-07"})
    policy["runtime"]["predictions"], policy["runtime"]["r33_rank_pool"] = predictions, snapshot
    plan_rows = run(deepcopy(rows), policy, return_history=history)
    plan = plan_rows[0]["_l4_portfolio_plan"]
    assert plan["prediction_coverage"]["unavailable"] == {"P6": ["r33_unscored:stale:last_bar=2026-11-07"]}
    assert plan["weights"]["P6"] == 0


def test_l3_audit_records_coverage_not_drop(monkeypatch):
    predictions, _ = _chain(stale={"P6": "no_bars"})
    captured = []
    monkeypatch.setattr(reco, "OPS_D1_CLIENT", SimpleNamespace(batch_execute=captured.extend))
    reco.write_layer3_formal_gate_audit(predictions=predictions, recommendations=[{"symbol": s} for s in POOL[:5]],
                                        layer2_symbols=POOL, run_date=DAY, screener_run_id="run-1")
    decisions = {params[2]: (params[5], params[6]) for _sql, params in captured[1:]}
    assert json.loads(captured[1 + POOL.index("P6")][1][10])["schema_version"] == "layer3_r33_coverage_audit_v1"
    assert decisions["P6"] == ("unscored", "r33_unscored:stale:no_bars:not_in_final_rows")
    assert all(decisions[s] == ("pass", "r33_scored") for s in POOL[:5])


@pytest.mark.parametrize("with_xgboost", [False, True])
def test_normalize_accepts_the_r33_roster_and_feeds_the_rank_pool(with_xgboost):
    from services.active8_score_semantics import MODEL_TARGET_SEMANTIC_VERSION, normalize_active8_cross_sectional_scores
    ensemble = _ensemble()
    names = [*MODELS, *(["XGBoost"] if with_xgboost else [])]
    versions = {m: ensemble["base_artifacts"][m]["version"] if m in MODELS else "x" for m in names}
    predictions = {s: {"stock_meta": {"market_segment": "LISTED"},
                       "rank_scores": {m: i / 10 + 0.01 * j for j, m in enumerate(names)}} for i, s in enumerate(POOL)}
    report = normalize_active8_cross_sectional_scores(
        predictions, artifact_versions=versions, artifact_target_semantics={m: MODEL_TARGET_SEMANTIC_VERSION for m in names},
        run_date=DAY, active8_ensemble=ensemble, pool_models=POOL_MODELS)
    assert report
    lineage = predictions["P1"]["model_score_lineage"]
    assert lineage["coverage_policy"] == r33_ensemble.COVERAGE_POLICY and lineage["complete"] is True
    receipt = {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "r", "membership_sha256": "p" * 64}
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=(POOL, receipt), predictions=predictions, holdings=[],
                                         ensemble=ensemble, l3_identity=IDENTITY, stale=None)
    assert snapshot["coverage"]["pool_scored_rows"] == len(POOL)


def test_normalize_rejects_a_dlinear_slot_under_r33():
    from services.active8_score_semantics import normalize_active8_cross_sectional_scores
    with pytest.raises(ValueError, match="active8_score_artifact_roster_mismatch"):
        normalize_active8_cross_sectional_scores({}, artifact_versions={"DLinear": "v", "LightGBM": "v"},
                                                 artifact_target_semantics={}, run_date=DAY,
                                                 active8_ensemble=_ensemble(), pool_models=POOL_MODELS)


def test_buy_needs_ehat_strictly_above_cost():
    prediction = _prediction(0.0)
    receipt = {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "r", "membership_sha256": "p" * 64}
    predictions = {s: _prediction(v) for s, v in zip(POOL, (-0.5, -0.1, 0.2, 0.6, 1.0, 1.4))}
    rank_pool.build_rank_pool(signal_date=DAY, pool=(POOL, receipt), predictions=predictions, holdings=[],
                              ensemble=_ensemble(), l3_identity=IDENTITY)
    prediction = predictions["P6"]
    ehat = prediction[rank_pool.EVIDENCE_KEY]["expected_excess"]
    assert ehat > 0
    view = r33_ensemble.serving_view(prediction, _ensemble(), cost=float(ehat))
    assert view["signal"] == "HOLD"
    assert r33_ensemble.serving_view(prediction, _ensemble(), cost=float(ehat) * 0.999)["signal"] == "BUY"


def test_l3_audit_records_a_pool_name_without_any_prediction_as_unscored(monkeypatch):
    predictions, _ = _chain()
    predictions.pop("P6")
    captured = []
    monkeypatch.setattr(reco, "OPS_D1_CLIENT", SimpleNamespace(batch_execute=captured.extend))
    reco.write_layer3_formal_gate_audit(predictions=predictions, recommendations=[{"symbol": s} for s in POOL[:5]],
                                        layer2_symbols=POOL, run_date=DAY, screener_run_id="run-1")
    decisions = {params[2]: (params[5], params[6]) for _sql, params in captured[1:]}
    assert decisions["P6"] == ("unscored", "r33_unscored:prediction_missing:not_in_final_rows")
