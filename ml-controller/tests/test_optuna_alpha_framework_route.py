from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import optuna  # noqa: E402


def test_alpha_framework_route_returns_and_pushes_risk_overlay_evidence(monkeypatch):
    captured: dict = {}
    evidence = {
        "method": "posterior_numeric_outcome_distribution",
        "numeric_sample_counts": {"volatility": 42},
        "adaptive_fields": ["alphaFramework.riskOverlay.highVolThreshold"],
        "fallback_fields": [],
    }

    monkeypatch.setattr(
        optuna,
        "load_active_trading_config",
        lambda: {"alphaFramework": {"quality": {
            "outcomeLimit": 900,
            "minSamples": 40,
            "minRegimeSamples": 7,
            "minBucketSamples": 5,
            "posteriorFullConfidenceSamples": 11,
            "posteriorWeightImpactBps": 1500,
            "minBucketWeightBps": 250,
            "returnPctPerRBps": 300,
            "directionCorrectFallbackRBps": 1250,
        }}},
    )
    monkeypatch.setattr(optuna, "load_alpha_outcome_rows", lambda limit: [{"id": 1}] * 42)
    def fake_build(rows, **kwargs):
        captured["build_kwargs"] = kwargs
        return {
            "status": "completed",
            "alphaFramework": {
                "riskOverlay": {"highVolThreshold": 0.042},
                "allocation": {"slateSize": 10, "weights": {}},
            },
            "sample_count": len(rows),
            "regime_counts": {"bull": 10},
            "bucket_counts": {"trend_following": 10},
            "skipped_count": 2,
            "risk_overlay_evidence": evidence,
        }

    monkeypatch.setattr(optuna, "build_alpha_policy_candidate", fake_build)

    def fake_push(*, source, params, meta):
        captured["source"] = source
        captured["params"] = params
        captured["meta"] = meta
        return {"success": True, "sandbox_id": "sandbox-1"}

    monkeypatch.setattr(optuna, "push_optuna_result", fake_push)

    out = optuna.run_alpha_framework(optuna.OptunaReq(push_kv=True, dry_run=False, subset_size=500))

    assert out["status"] == "completed"
    assert out["risk_overlay_evidence"] == evidence
    assert captured["source"] == "alpha_framework"
    assert captured["meta"]["risk_overlay_evidence"] == evidence
    assert captured["build_kwargs"] == {
        "min_samples": 40,
        "min_regime_samples": 7,
        "min_bucket_samples": 5,
        "posterior_full_confidence_samples": 11,
        "posterior_weight_impact": 0.15,
        "min_bucket_weight": 0.025,
        "return_pct_per_r": 0.03,
        "direction_correct_fallback_r": 0.125,
    }


def test_alpha_framework_route_uses_quality_outcome_limit_when_subset_omitted(monkeypatch):
    captured: dict = {}

    monkeypatch.setattr(
        optuna,
        "load_active_trading_config",
        lambda: {"alphaFramework": {"quality": {"outcomeLimit": 777, "minSamples": 3, "minBucketSamples": 2}}},
    )
    def fake_load(limit):
        captured["limit"] = limit
        return [{"id": 1}] * 3

    monkeypatch.setattr(optuna, "load_alpha_outcome_rows", fake_load)
    monkeypatch.setattr(
        optuna,
        "build_alpha_policy_candidate",
        lambda rows, **kwargs: {
            "status": "completed",
            "alphaFramework": {"riskOverlay": {}, "allocation": {"weights": {}}},
            "sample_count": len(rows),
        },
    )

    out = optuna.run_alpha_framework(optuna.AlphaFrameworkOptunaReq(push_kv=False, dry_run=True))

    assert out["status"] == "completed"
    assert captured["limit"] == 777
