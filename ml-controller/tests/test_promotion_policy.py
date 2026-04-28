from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.promotion_policy import (  # noqa: E402
    PromotionPolicy,
    evaluate_alpha_policy_candidate,
    evaluate_promotion_candidate,
)


def _passing_inputs() -> tuple[dict, dict, dict]:
    backtest = {
        "mode": "B",
        "total_trades": 120,
        "sharpe": 1.2,
        "sortino": 1.8,
        "max_drawdown": 0.12,
        "profit_factor": 1.45,
        "absolute_confidence": "moderate",
        "sanity_flags": [],
        "per_regime": {
            "bull_market": {"trades": 40, "return": 0.12},
            "sideways": {"trades": 50, "return": 0.04},
            "bear_market": {"trades": 30, "return": 0.01},
        },
        "parity_audit": {
            "worker_parity": {
                "decision": "PASS",
                "drift_rate": 0.0,
                "failed": 0,
                "total": 12,
            }
        },
    }
    monte_carlo = {
        "source": "backtest",
        "n_trades": 120,
        "simulation_method": "block_bootstrap",
        "mdd_95th": "18.00%",
        "go_live_verdict": "PASS",
    }
    pbo = {
        "source": "backtest",
        "n_trades": 120,
        "method": "cscv_rank_logit",
        "pbo": 0.35,
        "oos_mean_return": "4.00%",
        "go_live_verdict": "PASS",
    }
    return backtest, monte_carlo, pbo


def test_promotion_policy_accepts_candidate_that_passes_all_gates():
    backtest, monte_carlo, pbo = _passing_inputs()

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo)

    assert verdict["decision"] == "PASS"
    assert verdict["passed"] is True
    assert verdict["failed_gates"] == []


def test_promotion_policy_rejects_mode_a_even_when_metrics_are_good():
    backtest, monte_carlo, pbo = _passing_inputs()
    backtest["mode"] = "A"

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo)

    assert verdict["decision"] == "FAIL"
    assert "backtest_mode_b_required" in verdict["failed_gates"]


def test_promotion_policy_rejects_missing_worker_parity_audit():
    backtest, monte_carlo, pbo = _passing_inputs()
    backtest.pop("parity_audit")

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo)

    assert verdict["decision"] == "FAIL"
    assert "backtest_worker_parity" in verdict["failed_gates"]


def test_promotion_policy_rejects_worker_parity_drift():
    backtest, monte_carlo, pbo = _passing_inputs()
    backtest["parity_audit"]["worker_parity"] = {
        "decision": "FAIL",
        "drift_rate": 0.08,
        "failed": 1,
        "total": 12,
    }

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo)

    assert verdict["decision"] == "FAIL"
    assert "backtest_worker_parity" in verdict["failed_gates"]


def test_promotion_policy_rejects_bad_tail_risk_and_overfit():
    backtest, monte_carlo, pbo = _passing_inputs()
    monte_carlo["mdd_95th"] = "31.00%"
    pbo["pbo"] = 0.62

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo)

    assert verdict["decision"] == "FAIL"
    assert "monte_carlo_mdd_95th" in verdict["failed_gates"]
    assert "pbo_probability" in verdict["failed_gates"]


def test_promotion_policy_rejects_proxy_pbo_even_when_metrics_look_good():
    backtest, monte_carlo, pbo = _passing_inputs()
    pbo["method"] = "cpcv_single_strategy_proxy"

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo)

    assert verdict["decision"] == "FAIL"
    assert "pbo_method" in verdict["failed_gates"]


def test_promotion_policy_rejects_legacy_iid_monte_carlo():
    backtest, monte_carlo, pbo = _passing_inputs()
    monte_carlo["simulation_method"] = "iid_shuffle"

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo)

    assert verdict["decision"] == "FAIL"
    assert "monte_carlo_method" in verdict["failed_gates"]


def test_promotion_policy_accepts_regime_block_bootstrap_monte_carlo():
    backtest, monte_carlo, pbo = _passing_inputs()
    monte_carlo["simulation_method"] = "regime_block_bootstrap"
    monte_carlo["regime_counts"] = {"green": 40, "yellow": 40, "red": 40}

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo)

    assert verdict["decision"] == "PASS"


def test_promotion_policy_reads_env_threshold_overrides(monkeypatch):
    monkeypatch.setenv("PROMOTION_MAX_MC_MDD_95TH", "0.10")
    policy = PromotionPolicy.from_env()
    backtest, monte_carlo, pbo = _passing_inputs()

    verdict = evaluate_promotion_candidate(backtest, monte_carlo, pbo, policy=policy)

    assert verdict["decision"] == "FAIL"
    assert "monte_carlo_mdd_95th" in verdict["failed_gates"]


def test_alpha_policy_gate_requires_sandbox_candidate_with_enough_outcomes():
    backtest, monte_carlo, pbo = _passing_inputs()
    candidate = {
        "status": "completed",
        "target": "sandbox",
        "sample_count": 18,
        "regime_counts": {"bull": 18},
        "alphaFramework": {"allocation": {"weights": {}}},
    }

    verdict = evaluate_alpha_policy_candidate(candidate, backtest, monte_carlo, pbo)

    assert verdict["decision"] == "FAIL"
    assert "alpha_min_outcomes" in verdict["failed_gates"]
    assert "alpha_min_regime_outcomes:bear" in verdict["failed_gates"]


def test_alpha_policy_gate_passes_only_after_domain_and_risk_gates_pass():
    backtest, monte_carlo, pbo = _passing_inputs()
    candidate = {
        "status": "completed",
        "target": "sandbox",
        "sample_count": 96,
        "regime_counts": {"bull": 24, "bear": 24, "volatile": 24, "sideways": 24},
        "alphaFramework": {"allocation": {"weights": {"bull": {"trend_following": 1.0}}}},
    }

    verdict = evaluate_alpha_policy_candidate(candidate, backtest, monte_carlo, pbo)

    assert verdict["decision"] == "PASS"
    assert verdict["passed"] is True
    assert verdict["candidate"]["sample_count"] == 96


def test_alpha_policy_gate_accepts_worker_sandbox_record_shape():
    backtest, monte_carlo, pbo = _passing_inputs()
    sandbox_record = {
        "source": "alpha_framework",
        "config": {"alphaFramework": {"allocation": {"weights": {}}}},
        "metadata": {
            "status": "completed",
            "target": "sandbox",
            "sample_count": 96,
            "regime_counts": {"bull": 24, "bear": 24, "volatile": 24, "sideways": 24},
        },
    }

    verdict = evaluate_alpha_policy_candidate(sandbox_record, backtest, monte_carlo, pbo)

    assert verdict["decision"] == "PASS"
    assert verdict["candidate"]["target"] == "sandbox"
