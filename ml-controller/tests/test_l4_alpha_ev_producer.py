from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import recommendation_service  # noqa: E402
from services.l4_alpha_ev_producer import materialize_l4_alpha_ev  # noqa: E402
from services.l4_alpha_ev_resolver import SNAPSHOT_BACKFILL_USAGE_SCOPE  # noqa: E402
from services.recommendation_service import (  # noqa: E402
    apply_sparse_tangent_allocation,
    filter_and_score_recommendations,
)


def _artifact(**overrides):
    base = {
        "schema_version": "l4-alpha-ev-artifact-v2",
        "artifact_contract_version": "l4-alpha-ev-contract-v2",
        "promotion_state": "production_approved",
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "resolver_method": "regularized_meta_calibrator",
        "model_version": "l4-alpha-ev-20260707",
        "feature_snapshot_version": "l4-alpha-feature-snapshot-v4-directional-components",
        "feature_semantic_version": "l4-directional-score-components-v2-lineage-bound",
        "label_schema_version": "next-session-adjusted-open-to-fifth-session-adjusted-close-net-v1",
        "trained_until": "2026-07-06",
        "horizon_days": 3,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
        "feature_families": ["score_v2_components", "formal_ml_direction"],
        "feature_names": [
            "ml_edge_norm",
            "fundamental_quality_norm",
            "chip_flow_norm",
            "technical_structure_norm",
            "ensemble_directional_margin",
        ],
        "intercept": -0.002,
        "coefficients": {
            "ml_edge_norm": 0.008,
            "fundamental_quality_norm": 0.006,
            "chip_flow_norm": 0.004,
            "technical_structure_norm": 0.004,
            "ensemble_directional_margin": 0.012,
        },
        "output_clip": {"min": -0.08, "max": 0.08},
    }
    base.update(overrides)
    return base


def _score_components(*, final_score=82.0, ml_edge=20.0, fundamental_quality=18.0):
    return {
        "version": "score_v2",
        "weights": {
            "mlEdge": 25,
            "chipFlow": 25,
            "technicalStructure": 25,
            "fundamentalQuality": 25,
            "newsTheme": 0,
        },
        "components": {
            "mlEdge": ml_edge,
            "chipFlow": 21.0,
            "technicalStructure": 22.0,
            "fundamentalQuality": fundamental_quality,
            "newsTheme": 0.0,
        },
        "total": final_score,
        "finalScore": final_score,
    }


def _row():
    return {
        "symbol": "2330",
        "score": 82.0,
        "score_components": _score_components(),
        "alpha_context": {
            "edge_bucket": "trend_following",
            "regime": "bull",
            "regime_weight": 1.08,
            "risk_overlay": {"penalty": 0.5, "flags": []},
        },
    }


def _prediction(signal="HOLD"):
    return {
        "signal": "HOLD",
        "confidence": 0.52,
        "forecast_pct": 0.004,
        "ensemble_v2": {
            "signal": signal,
            "confidence": 0.76,
            "avg_rank": 0.72,
            "signal_source": "ensemble_v2_topk_policy",
        },
        "models": {"XGBoost": {"direction": "up"}, "ExtraTrees": {"direction": "up"}},
    }


def test_materialize_l4_alpha_ev_uses_production_learned_artifact():
    payload = materialize_l4_alpha_ev(
        _row(),
        prediction=_prediction(),
        policy={"l4_alpha_ev": _artifact()},
    )

    assert payload["status"] == "loaded"
    assert payload["expected_return_owner"] == "l4_alpha_ev"
    assert payload["expected_return_source"] == "l4_alpha_ev:regularized_meta_calibrator"
    assert payload["validation_decision"] == "PASS"
    assert payload["approval_state"] == "production_approved"
    assert payload["expected_return"] == pytest.approx(0.01824)
    assert payload["feature_values"]["fundamental_quality_norm"] == pytest.approx(0.72)


def test_materialize_l4_alpha_ev_rejects_legacy_unsigned_confidence_artifact():
    legacy = _artifact(
        schema_version="l4-alpha-ev-artifact-v1",
        artifact_contract_version=None,
        feature_semantic_version=None,
        label_schema_version=None,
        feature_names=["score_final_norm", "ensemble_avg_rank_centered", "ensemble_confidence_centered"],
        coefficients={
            "score_final_norm": 0.045,
            "ensemble_avg_rank_centered": -0.071,
            "ensemble_confidence_centered": 0.057,
        },
    )
    payload = materialize_l4_alpha_ev(
        _row(),
        prediction=_prediction(),
        policy={"l4_alpha_ev": legacy},
    )

    assert payload["status"] == "rejected"
    assert payload["expected_return"] is None
    assert "artifact_contract_version_incompatible" in payload["blockers"]
    assert "feature_semantic_version_incompatible" in payload["blockers"]
    assert "label_schema_version_incompatible" in payload["blockers"]


def test_materialize_l4_alpha_ev_allows_fitted_fail_only_for_snapshot_backfill():
    artifact = _artifact(
        promotion_state="snapshot_backfill_only",
        validation_packet={"decision": "FAIL", "failed_gates": ["insufficient_dates", "walk_forward_not_stable"]},
        snapshot_backfill_only=True,
        snapshot_backfill_fit_eligible=True,
        snapshot_backfill_usage_scope=SNAPSHOT_BACKFILL_USAGE_SCOPE,
        fitted=True,
        fit_blockers=[],
    )
    production_payload = materialize_l4_alpha_ev(
        _row(),
        prediction=_prediction(),
        policy={"l4_alpha_ev": artifact},
    )
    backfill_payload = materialize_l4_alpha_ev(
        _row(),
        prediction=_prediction(),
        policy={"l4_alpha_ev": artifact},
        usage_scope=SNAPSHOT_BACKFILL_USAGE_SCOPE,
    )

    assert production_payload["status"] == "rejected"
    assert production_payload["expected_return"] is None
    assert backfill_payload["status"] == "loaded"
    assert backfill_payload["snapshot_backfill_eligible"] is True
    assert backfill_payload["production_eligible"] is False


def test_materialize_l4_alpha_ev_keeps_non_fitted_backfill_artifact_rejected():
    artifact = _artifact(
        promotion_state="snapshot_backfill_only",
        validation_packet={"decision": "FAIL", "failed_gates": ["insufficient_dates"]},
        snapshot_backfill_only=True,
        snapshot_backfill_fit_eligible=True,
        snapshot_backfill_usage_scope=SNAPSHOT_BACKFILL_USAGE_SCOPE,
        fitted=False,
        fit_blockers=["insufficient_fit_dates"],
    )
    payload = materialize_l4_alpha_ev(
        _row(),
        prediction=_prediction(),
        policy={"l4_alpha_ev": artifact},
        usage_scope=SNAPSHOT_BACKFILL_USAGE_SCOPE,
    )

    assert payload["status"] == "rejected"
    assert payload["expected_return"] is None
    assert "validation_packet_not_pass" in payload["blockers"]
    assert payload["snapshot_backfill_eligible"] is False


def test_materialize_l4_alpha_ev_rejects_empirical_calibration_as_owner():
    payload = materialize_l4_alpha_ev(
        _row(),
        prediction=_prediction(),
        policy={"l4_alpha_ev": {"expectedReturnCalibration": {"method": "empirical_rank_bins"}}},
    )

    assert payload["status"] == "rejected"
    assert payload["expected_return"] is None
    assert "expected_return_calibration_is_not_l4_alpha_ev_artifact" in payload["blockers"]
    assert "empirical_bucket_not_production_alpha_ev_owner" in payload["blockers"]


def test_materialize_l4_alpha_ev_fails_closed_on_missing_required_feature():
    artifact = _artifact()
    artifact["feature_names"] = [*artifact["feature_names"], "market_heat_expected_return"]
    artifact["coefficients"] = {**artifact["coefficients"], "market_heat_expected_return": 1.0}
    payload = materialize_l4_alpha_ev(
        _row(),
        prediction=_prediction(),
        policy={"l4_alpha_ev": artifact},
    )

    assert payload["status"] == "rejected"
    assert payload["expected_return"] is None
    assert "canonical_feature_set_mismatch" in payload["blockers"]


def test_materialize_l4_alpha_ev_rejects_s12_context_in_selection_owner():
    row = {
        **_row(),
        "s12_trade_ev": {
            "schema_version": "s12-trade-ev-v1",
            "status": "loaded",
            "s12_entry_context": {"reward_confidence_multiplier": 0.82},
        },
    }
    artifact = _artifact()
    artifact["feature_names"] = [*artifact["feature_names"], "s12_context_multiplier_minus_1"]
    artifact["coefficients"] = {**artifact["coefficients"], "s12_context_multiplier_minus_1": 1.0}
    payload = materialize_l4_alpha_ev(
        row,
        prediction=_prediction(),
        policy={"l4_alpha_ev": artifact},
    )

    assert payload["status"] == "rejected"
    assert payload["expected_return"] is None
    assert "canonical_feature_set_mismatch" in payload["blockers"]


def test_filter_and_score_materializes_l4_alpha_ev_for_allocator(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)
    screener_rec = {
        "id": 1,
        "date": "2026-07-06",
        "stock_id": 2330,
        "symbol": "2330",
        "name": "TSMC",
        "sector": "semiconductor",
        "current_price": 100.0,
        "score_components": _score_components(final_score=82.0, ml_edge=20.0, fundamental_quality=18.0),
    }
    prediction = _prediction(signal="BUY")
    payload = {
        "symbol": "2330",
        "stock_id": "2330",
        "prices": [{"date": "2026-07-06", "open": 99.0, "high": 102.0, "low": 98.0, "close": 100.0}],
        "chips": [{"date": "2026-07-06", "foreign_net": 1000, "trust_net": 100}],
        "indicators": [{"date": "2026-07-06", "rsi14": 58.0, "macdHist": 0.2, "ma20": 96.0}],
        "stock_meta": {"market_segment": "LISTED", "recommendation_lane": "tradable"},
    }

    final, sell_count = filter_and_score_recommendations(
        [screener_rec],
        {"2330": prediction},
        [payload],
        alpha_policy={"l4_alpha_ev": _artifact()},
        fundamental_quality_by_symbol={"2330": {"score": 18.0}},
    )
    promoted = apply_sparse_tangent_allocation(
        final,
        ranking_config={"enabled": True, "promoteMinForecastPct": 0.005, "promoteMinMlEdge": 0.0},
        alpha_policy={"allocation": {"engine": "sparse_tangent_inverse_risk", "buy_signal_count": 1, "slate_size": 1}},
    )

    assert sell_count == 0
    assert final[0]["l4_alpha_ev"]["status"] == "loaded"
    assert prediction["l4_alpha_ev"]["status"] == "loaded"
    assert prediction["ensemble_v2"]["l4_alpha_ev"]["status"] == "loaded"
    assert promoted[0]["alpha_allocation"]["expected_return_owner"] == "l4_alpha_ev"
    assert promoted[0]["alpha_allocation"]["expected_return"] > 0
    assert promoted[0]["alpha_allocation"]["l4_alpha_ev"]["status"] == "loaded"
