from __future__ import annotations

import pytest

from services.ml_threshold_policy import (
    ThresholdPolicyError,
    load_threshold_policy_snapshot,
    resolve_ml_threshold_policy,
    validate_threshold_policy_candidate,
)
from services import payload_builder, recommendation_service


def _adaptive(run_date: str, delta: float = 0.05) -> dict:
    return {
        "confidence_delta": delta,
        "threshold_components": {
            "effective_delta": delta,
            "formula": "test_delta",
        },
        "computed_at": f"{run_date}T18:00:00+08:00",
        "provenance": {
            "owner": "ml-controller",
            "source": "risk-assess",
            "schema_version": "adaptive-params-v2",
            "update_frequency": "daily_after_verify",
            "computed_at": f"{run_date}T18:00:00+08:00",
            "fallback": False,
        },
    }


def _policy() -> dict:
    return {
        "schema_version": "ml-threshold-policy-v1",
        "policy_id": "policy-20260704",
        "version": "v1",
        "status": "champion",
        "source": "unit-test",
        "trained_until": "2026-07-03",
        "effective_from": "2026-07-04",
        "expires_at": "2026-07-10",
        "regime": "bull",
        "delta_cap": 0.02,
        "thresholds": {
            "strongBuyThreshold": 0.85,
            "buyThreshold": 0.70,
            "sellThreshold": 0.30,
            "strongSellThreshold": 0.15,
        },
        "validation_evidence": {
            "status": "pass",
            "walk_forward_oos": {"status": "pass"},
            "cpcv_pbo": {"status": "pass", "pbo": 0.05},
            "regime_segments": {"status": "pass"},
            "twse_otc_segments": {"status": "pass"},
            "turnover_capacity": {"status": "pass"},
            "collapse_guard": {"status": "pass", "all_hold": False, "all_buy": False},
        },
    }


def test_resolve_ml_threshold_policy_applies_bounded_overlay_and_provenance():
    resolved = resolve_ml_threshold_policy(
        run_date="2026-07-04",
        regime_contract={
            "alpha_regime": "bull",
            "source": "market_regime_state",
            "regime_surface": {"bull_market": 0.82, "sideways": 0.18},
        },
        ev2_cfg={},
        adaptive_params=_adaptive("2026-07-04", delta=0.05),
        policy_snapshot=_policy(),
    )

    assert resolved.thresholds["buyThreshold"] == 0.72
    assert resolved.thresholds["sellThreshold"] == 0.28
    assert resolved.adaptive_overlay["raw_delta"] == 0.05
    assert resolved.adaptive_overlay["applied_delta"] == 0.02
    assert resolved.evidence()["delta_cap"] == 0.02
    assert resolved.evidence()["policy_id"] == "policy-20260704"
    assert resolved.evidence()["evidence_hash"]


def test_resolve_ml_threshold_policy_accepts_recent_prior_day_adaptive_overlay():
    resolved = resolve_ml_threshold_policy(
        run_date="2026-07-04",
        regime_contract={"alpha_regime": "bull", "regime_surface": {"bull_market": 1.0}},
        ev2_cfg={},
        adaptive_params=_adaptive("2026-07-03", delta=0.01),
        policy_snapshot=_policy(),
    )

    assert resolved.thresholds["buyThreshold"] == 0.71
    assert resolved.thresholds["sellThreshold"] == 0.29
    assert resolved.adaptive_overlay["status"] == "applied"
    assert resolved.adaptive_overlay["age_days"] == 1
    assert resolved.adaptive_overlay["applied_delta"] == 0.01


def test_resolve_ml_threshold_policy_skips_stale_adaptive_overlay_without_blocking_runtime():
    policy = {**_policy(), "effective_from": "2026-07-07", "expires_at": "2026-07-14"}
    resolved = resolve_ml_threshold_policy(
        run_date="2026-07-07",
        regime_contract={"alpha_regime": "bull", "regime_surface": {"bull_market": 1.0}},
        ev2_cfg={},
        adaptive_params=_adaptive("2026-06-26", delta=0.05),
        policy_snapshot=policy,
    )

    assert resolved.thresholds["buyThreshold"] == 0.70
    assert resolved.thresholds["sellThreshold"] == 0.30
    assert resolved.adaptive_overlay["status"] == "skipped"
    assert "adaptive params stale" in resolved.adaptive_overlay["reason"]
    assert resolved.adaptive_overlay["computed_at"] == "2026-06-26"
    assert resolved.adaptive_overlay["applied_delta"] == 0.0


def test_resolve_ml_threshold_policy_rejects_candidate_runtime_status():
    candidate = {**_policy(), "status": "candidate"}
    with pytest.raises(ThresholdPolicyError, match="not production-eligible"):
        resolve_ml_threshold_policy(
            run_date="2026-07-04",
            regime_contract={"alpha_regime": "bull", "regime_surface": {"bull_market": 1.0}},
            ev2_cfg={},
            adaptive_params=_adaptive("2026-07-04", delta=0.01),
            policy_snapshot=candidate,
        )


def test_resolve_ml_threshold_policy_requires_delta_cap_artifact_parameter():
    policy = dict(_policy())
    policy.pop("delta_cap", None)

    with pytest.raises(ThresholdPolicyError, match="missing delta_cap"):
        resolve_ml_threshold_policy(
            run_date="2026-07-04",
            regime_contract={"alpha_regime": "bull", "regime_surface": {"bull_market": 1.0}},
            ev2_cfg={},
            adaptive_params=_adaptive("2026-07-04", delta=0.01),
            policy_snapshot=policy,
        )


def test_candidate_gate_blocks_live_config_mutation_and_missing_validation():
    candidate = {
        **_policy(),
        "status": "candidate",
        "mutates_trading_config": True,
        "validation_evidence": {
            "collapse_guard": {"status": "pass", "all_hold": False, "all_buy": False},
        },
    }

    result = validate_threshold_policy_candidate(candidate)

    assert result["ok"] is False
    assert "ga_optuna_candidate_must_not_mutate_trading_config" in result["blockers"]
    assert any(str(item).startswith("validation_evidence_missing:") for item in result["blockers"])


def test_candidate_gate_requires_delta_cap_artifact_parameter():
    candidate = {**_policy(), "status": "candidate"}
    candidate.pop("delta_cap", None)

    result = validate_threshold_policy_candidate(candidate)

    assert result["ok"] is False
    assert "ml_threshold_policy missing delta_cap artifact parameter" in result["blockers"]


def test_payload_builder_prefers_run_date_scoped_adaptive_params(monkeypatch):
    def fake_get_json(key, default=None, timeout=30.0):
        if key == "ml:adaptive_params:2026-07-04":
            return _adaptive("2026-07-04", delta=0.04)
        if key == "ml:adaptive_params":
            return _adaptive("2026-07-05", delta=0.01)
        return default

    monkeypatch.setattr(payload_builder.kv_client, "get_json", fake_get_json)
    monkeypatch.setattr(payload_builder.kv_client, "get", lambda *_args, **_kwargs: None)

    params = payload_builder.load_effective_adaptive_params(run_date="2026-07-04")

    assert params["confidence_delta"] == 0.04
    assert params["runtime_source_key"] == "ml:adaptive_params:2026-07-04"


def test_payload_builder_prefers_recent_scoped_adaptive_params_before_stale_global(monkeypatch):
    seen: list[str] = []

    def fake_get_json(key, default=None, timeout=30.0):
        seen.append(key)
        if key == "ml:adaptive_params:2026-07-06":
            return _adaptive("2026-07-06", delta=0.06)
        if key == "ml:adaptive_params":
            return _adaptive("2026-06-26", delta=0.01)
        return default

    monkeypatch.setattr(payload_builder.kv_client, "get_json", fake_get_json)
    monkeypatch.setattr(payload_builder.kv_client, "get", lambda *_args, **_kwargs: None)

    params = payload_builder.load_effective_adaptive_params(run_date="2026-07-07")

    assert params["confidence_delta"] == 0.06
    assert params["runtime_source_key"] == "ml:adaptive_params:2026-07-06"
    assert seen[:2] == ["ml:adaptive_params:2026-07-07", "ml:adaptive_params:2026-07-06"]
    assert "ml:adaptive_params" not in seen


def test_policy_loader_prefers_run_date_scoped_snapshot():
    class KV:
        def get_json(self, key, default=None):
            if key == "ml:threshold_policy:snapshot:2026-07-04":
                return {**_policy(), "version": "scoped"}
            if key == "ml:threshold_policy:champion":
                return {**_policy(), "version": "champion"}
            return default

    snapshot = load_threshold_policy_snapshot(
        kv_reader=KV(),
        trading_config={},
        ev2_cfg={},
        run_date="2026-07-04",
    )

    assert snapshot["version"] == "scoped"


def test_score_v2_ml_edge_uses_threshold_policy_distance_not_signal_tier():
    raw_prediction = {
        "ensemble_v2": {
            "signal": "HOLD",
            "signal_source": "ensemble_v2",
            "avg_rank": 0.775,
            "weight_total": 1.0,
            "contributing_models": ["LightGBM", "TabM"],
            "ml_threshold_policy": {
                "policy_id": "policy-20260704",
                "version": "v1",
                "selected_regime": "bull",
                "evidence_hash": "abc123",
                "thresholds": {
                    "strongBuyThreshold": 0.85,
                    "buyThreshold": 0.70,
                    "sellThreshold": 0.30,
                    "strongSellThreshold": 0.15,
                },
            },
        },
    }

    score = recommendation_service.calculate_ml_score(
        {"signal": "HOLD", "confidence": 0.90, "forecast_pct": 0.0, "signal_source": "ensemble_v2"},
        raw_prediction,
    )

    assert score == pytest.approx(22.0)


def test_score_v2_ml_edge_fails_closed_when_ensemble_v2_has_no_policy_evidence():
    raw_prediction = {
        "ensemble_v2": {
            "signal": "BUY",
            "signal_source": "ensemble_v2",
            "avg_rank": 0.92,
            "weight_total": 1.0,
            "rank_signal_thresholds": {
                "strongBuyThreshold": 0.85,
                "buyThreshold": 0.70,
                "sellThreshold": 0.30,
                "strongSellThreshold": 0.15,
            },
        },
    }

    score = recommendation_service.calculate_ml_score(
        {"signal": "BUY", "confidence": 0.99, "forecast_pct": 0.05, "signal_source": "ensemble_v2"},
        raw_prediction,
    )

    assert score == 0.0


def test_local_rescore_can_overlay_threshold_policy_as_source_of_truth():
    raw_prediction = {
        "ensemble_v2": {
            "signal": "HOLD",
            "signal_source": "ensemble_v2",
            "avg_rank": 0.775,
            "weight_total": 1.0,
            "rank_signal_thresholds": {
                "strongBuyThreshold": 0.85,
                "buyThreshold": 0.70,
                "sellThreshold": 0.30,
                "strongSellThreshold": 0.15,
            },
        },
    }
    before = recommendation_service.calculate_ml_score(
        {"signal": "HOLD", "confidence": 0.90, "forecast_pct": 0.0, "signal_source": "ensemble_v2"},
        raw_prediction,
    )

    overlaid = recommendation_service.overlay_ml_threshold_policy_source_of_truth(
        {"2330": raw_prediction},
        {
            "policy_id": "policy-20260704",
            "version": "v1",
            "selected_regime": "bull",
            "evidence_hash": "abc123",
            "thresholds": {
                "strongBuyThreshold": 0.85,
                "buyThreshold": 0.70,
                "sellThreshold": 0.30,
                "strongSellThreshold": 0.15,
            },
        },
    )
    after = recommendation_service.calculate_ml_score(
        {"signal": "HOLD", "confidence": 0.90, "forecast_pct": 0.0, "signal_source": "ensemble_v2"},
        overlaid["2330"],
    )

    assert before == 0.0
    assert after == pytest.approx(22.0)
    assert "ml_threshold_policy" not in raw_prediction["ensemble_v2"]


def test_score_v2_components_persist_ml_threshold_policy_evidence():
    row = {
        "score_seed_inputs": {
            "chipFlowSeed40": 18.0,
            "technicalSeed30": 16.0,
            "mlEdgeSeed30": 22.0,
            "personaAlphaSeed": 0.0,
        },
        "ml_edge_policy": {
            "schema_version": "score-v2-ml-edge-policy-v1",
            "source": "ensemble_v2.ml_threshold_policy",
            "policy_id": "policy-20260704",
            "score_seed30": 22.0,
        },
    }

    payload = recommendation_service.build_score_components(row, raw_score=56.0)

    assert payload["mlEdgePolicy"]["policy_id"] == "policy-20260704"
    assert payload["seedComponents"]["mlEdgeSeed30"] == pytest.approx(22.0)
