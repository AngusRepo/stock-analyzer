from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import optuna  # noqa: E402
from services import trading_config_loader  # noqa: E402


def _cfg_result(config: dict) -> SimpleNamespace:
    return SimpleNamespace(
        config=config,
        contract=SimpleNamespace(degraded=False, to_dict=lambda: {"degraded": False}),
    )


def test_alpha_framework_route_returns_and_pushes_risk_overlay_evidence(monkeypatch):
    captured: dict = {}
    evidence = {
        "method": "posterior_numeric_outcome_distribution",
        "numeric_sample_counts": {"volatility": 42},
        "adaptive_fields": ["alphaFramework.riskOverlay.highVolThreshold"],
        "fallback_fields": [],
    }

    monkeypatch.setattr(
        trading_config_loader,
        "load_merged_trading_config_with_contract",
        lambda: _cfg_result({"alphaFramework": {"quality": {
            "outcomeLimit": 900,
            "minSamples": 40,
            "minRegimeSamples": 7,
            "minBucketSamples": 5,
            "posteriorFullConfidenceSamples": 11,
            "posteriorWeightImpactBps": 1500,
            "minBucketWeightBps": 250,
            "returnPctPerRBps": 300,
            "directionCorrectFallbackRBps": 1250,
        }}}),
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
        trading_config_loader,
        "load_merged_trading_config_with_contract",
        lambda: _cfg_result({"alphaFramework": {"quality": {"outcomeLimit": 777, "minSamples": 3, "minBucketSamples": 2}}}),
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


def test_ga_optimizer_route_pushes_learning_state(monkeypatch):
    captured: dict = {}

    def fake_run(req):
        captured["req"] = req
        return {
            "status": "completed",
            "optimizer": "GAOptimizer",
            "population_size": req.population_size,
            "generations": req.generations,
            "best": {
                "score": 1.23,
                "gate": {"decision": "PASS", "passed": True},
                "plateau": {"plateau_size": 2},
                "candidate": {
                    "target": "meta_optimizer_learning",
                    "params": {
                        "alphaFramework": {
                            "riskOverlay": {"highVolThreshold": 0.045},
                            "allocation": {"weights": {"bull": {"trend_following": 0.5}}},
                        }
                    },
                },
            },
            "ranked": [],
            "contract": {"applies_to_production": False, "push_target": "worker_kv_ga_optimizer_state"},
        }

    def fake_push(*, source, params, meta):
        captured["source"] = source
        captured["params"] = params
        captured["meta"] = meta
        return {"success": True, "sandbox_id": "ga-1"}

    monkeypatch.setattr(optuna, "run_ga_optimizer_service", fake_run)
    monkeypatch.setattr(optuna, "push_optuna_result", fake_push)

    out = optuna.run_ga_optimizer(
        optuna.GAOptimizerReq(
            population_size=12,
            generations=4,
            push_kv=True,
            dry_run=False,
        )
    )

    assert out["status"] == "completed"
    assert out["source"] == "ga_optimizer"
    assert out["contract"]["scope"] == "production_meta_optimizer_learning"
    assert out["contract"]["applies_to_production"] == "learning_state_only_until_gated_promotion"
    assert out["contract"]["push_target"] == "worker_kv_ga_optimizer_state"
    assert captured["source"] == "ga_optimizer"
    assert captured["params"]["status"] == "learning"
    assert captured["params"]["best_alphaFramework"]["riskOverlay"]["highVolThreshold"] == 0.045
    assert captured["meta"]["optimizer"] == "GAOptimizer"
