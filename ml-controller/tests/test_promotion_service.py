from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.promotion_service import (  # noqa: E402
    build_alpha_policy_evidence_bundle,
    evaluate_alpha_policy_evidence_gate,
    evaluate_latest_alpha_policy_gate,
    evaluate_latest_promotion_gate,
    normalize_latest_backtest_row,
    normalize_latest_monte_carlo_row,
    normalize_latest_pbo_row,
)


def test_normalize_latest_backtest_row_prefers_raw_summary_and_preserves_mode_b():
    row = {
        "total_trades": 50,
        "sharpe": 0.7,
        "profit_factor": 1.2,
        "max_drawdown": 0.2,
        "raw_results": json.dumps({
            "mode": "B",
            "summary": {"total_trades": 120},
            "per_regime": {"sideways": {"trades": 20, "return": 0.03}},
            "parity_audit": {"worker_parity": {"decision": "PASS", "drift_rate": 0.0}},
            "sanity_flags": [],
            "absolute_confidence": "moderate",
        }),
    }

    out = normalize_latest_backtest_row(row)

    assert out["mode"] == "B"
    assert out["total_trades"] == 120
    assert out["per_regime"]["sideways"]["return"] == 0.03
    assert out["parity_audit"]["worker_parity"]["decision"] == "PASS"


def test_normalize_latest_backtest_row_ignores_loose_mode_column_without_raw_provenance():
    row = {
        "mode": "B",
        "total_trades": 120,
        "sharpe": 1.1,
        "profit_factor": 1.4,
        "max_drawdown": 0.11,
        "raw_results": json.dumps({"summary": {"total_trades": 120}}),
    }

    out = normalize_latest_backtest_row(row)

    assert out["mode"] == "legacy"


def test_normalize_latest_monte_carlo_row_uses_numeric_mdd():
    row = {
        "source": "backtest",
        "n_trades": 120,
        "mdd_95th": 0.18,
        "go_live_verdict": "PASS",
        "raw_distribution": json.dumps({
            "simulation_method": "block_bootstrap",
            "block_size": 10,
            "regime_counts": {"green": 60, "red": 60},
        }),
    }

    out = normalize_latest_monte_carlo_row(row)

    assert out == {
        "source": "backtest",
        "n_trades": 120,
        "simulation_method": "block_bootstrap",
        "block_size": 10,
        "regime_counts": {"green": 60, "red": 60},
        "mdd_95th": 0.18,
        "go_live_verdict": "PASS",
    }


def test_normalize_latest_pbo_row_uses_numeric_oos():
    row = {
        "source": "backtest",
        "n_trades": 120,
        "pbo": 0.35,
        "oos_mean_return": 0.04,
        "go_live_verdict": "PASS",
        "raw_details": json.dumps({"method": "cscv_rank_logit"}),
    }

    out = normalize_latest_pbo_row(row)

    assert out == {
        "source": "backtest",
        "n_trades": 120,
        "method": "cscv_rank_logit",
        "pbo": 0.35,
        "oos_mean_return": 0.04,
        "go_live_verdict": "PASS",
    }


def test_evaluate_latest_promotion_gate_joins_latest_mode_b_risk_checks(monkeypatch):
    rows = {
        "backtest_results": [{
            "run_date": "2026-04-25",
            "strategy": "mode-b",
            "total_trades": 50,
            "sharpe": 1.1,
            "profit_factor": 1.4,
            "max_drawdown": 0.11,
            "raw_results": json.dumps({
            "mode": "B",
            "summary": {"total_trades": 120},
            "per_regime": {"bull": {"trades": 40, "return": 0.08}},
            "parity_audit": {"worker_parity": {"decision": "PASS", "drift_rate": 0.0}},
            "sanity_flags": [],
            "absolute_confidence": "moderate",
        }),
        }],
        "monte_carlo_results": [{
            "source": "backtest",
            "n_trades": 120,
            "mdd_95th": 0.16,
            "go_live_verdict": "PASS",
            "raw_distribution": json.dumps({"simulation_method": "block_bootstrap", "block_size": 10}),
        }],
        "pbo_results": [{
            "source": "backtest",
            "n_trades": 120,
            "raw_details": json.dumps({"method": "cscv_rank_logit"}),
            "pbo": 0.31,
            "oos_mean_return": 0.03,
            "go_live_verdict": "PASS",
        }],
    }

    def fake_query(sql, params=None, timeout=60.0):
        for table, result in rows.items():
            if table in sql:
                return result
        return []

    import services.promotion_service as promotion_service

    monkeypatch.setattr(promotion_service, "query", fake_query)

    out = evaluate_latest_promotion_gate(source="backtest")

    assert out["decision"] == "PASS"
    assert out["inputs"]["backtest"]["mode"] == "B"
    assert out["metrics"]["mc_mdd_95th"] == 0.16


def test_evaluate_latest_promotion_gate_can_use_separate_pbo_source(monkeypatch):
    calls = []
    rows = {
        "backtest_results": [{
            "run_date": "2026-04-25",
            "strategy": "mode-b",
            "total_trades": 120,
            "sharpe": 1.1,
            "profit_factor": 1.4,
            "max_drawdown": 0.11,
            "raw_results": json.dumps({
            "mode": "B",
            "summary": {"total_trades": 120},
            "parity_audit": {"worker_parity": {"decision": "PASS", "drift_rate": 0.0}},
            "sanity_flags": [],
            "absolute_confidence": "moderate",
        }),
        }],
        "monte_carlo_results": [{
            "source": "backtest",
            "n_trades": 120,
            "mdd_95th": 0.16,
            "go_live_verdict": "PASS",
            "raw_distribution": json.dumps({"simulation_method": "block_bootstrap", "block_size": 10}),
        }],
        "pbo_results": [{
            "source": "optuna_l2",
            "n_trades": 0,
            "raw_details": json.dumps({"method": "cscv_rank_logit"}),
            "pbo": 0.25,
            "oos_mean_return": 0.03,
            "go_live_verdict": "PASS",
        }],
    }

    def fake_query(sql, params=None, timeout=60.0):
        calls.append((sql, params))
        for table, result in rows.items():
            if table in sql:
                return result
        return []

    import services.promotion_service as promotion_service

    monkeypatch.setattr(promotion_service, "query", fake_query)

    out = evaluate_latest_promotion_gate(source="backtest", pbo_source="optuna_l2")

    assert out["decision"] == "PASS"
    assert out["inputs"]["source"] == "backtest"
    assert out["inputs"]["pbo_source"] == "optuna_l2"
    assert ["optuna_l2"] in [params for _, params in calls if params]


def test_evaluate_latest_promotion_gate_fails_closed_when_risk_rows_missing(monkeypatch):
    def fake_query(sql, params=None, timeout=60.0):
        if "backtest_results" in sql:
            return [{
                "run_date": "2026-04-25",
                "strategy": "mode-b",
                "total_trades": 80,
                "sharpe": 1.0,
                "profit_factor": 1.3,
                "max_drawdown": 0.12,
                "raw_results": json.dumps({
                    "mode": "B",
                    "summary": {"total_trades": 80},
                    "parity_audit": {"worker_parity": {"decision": "PASS", "drift_rate": 0.0}},
                    "sanity_flags": [],
                    "absolute_confidence": "moderate",
                }),
            }]
        return []

    import services.promotion_service as promotion_service

    monkeypatch.setattr(promotion_service, "query", fake_query)

    out = evaluate_latest_promotion_gate(source="backtest")

    assert out["decision"] == "FAIL"
    assert "missing_monte_carlo_results" in out["failed_gates"]
    assert "missing_pbo_results" in out["failed_gates"]


def test_evaluate_latest_alpha_policy_gate_combines_candidate_and_latest_risk_gates(monkeypatch):
    rows = {
        "backtest_results": [{
            "run_date": "2026-04-25",
            "strategy": "mode-b",
            "total_trades": 120,
            "sharpe": 1.2,
            "profit_factor": 1.5,
            "max_drawdown": 0.1,
            "raw_results": json.dumps({
                "mode": "B",
                "summary": {"total_trades": 120},
                "parity_audit": {"worker_parity": {"decision": "PASS", "drift_rate": 0.0}},
                "sanity_flags": [],
                "absolute_confidence": "moderate",
            }),
        }],
        "monte_carlo_results": [{
            "source": "backtest",
            "n_trades": 120,
            "mdd_95th": 0.16,
            "go_live_verdict": "PASS",
            "raw_distribution": json.dumps({"simulation_method": "block_bootstrap", "block_size": 10}),
        }],
        "pbo_results": [{
            "source": "backtest",
            "n_trades": 120,
            "raw_details": json.dumps({"method": "cscv_rank_logit"}),
            "pbo": 0.31,
            "oos_mean_return": 0.03,
            "go_live_verdict": "PASS",
        }],
    }

    def fake_query(sql, params=None, timeout=60.0):
        for table, result in rows.items():
            if table in sql:
                return result
        return []

    import services.promotion_service as promotion_service

    monkeypatch.setattr(promotion_service, "query", fake_query)
    candidate = {
        "status": "completed",
        "target": "sandbox",
        "sample_count": 96,
        "regime_counts": {"bull": 24, "bear": 24, "volatile": 24, "sideways": 24},
        "alphaFramework": {"allocation": {"weights": {}}},
    }

    out = evaluate_latest_alpha_policy_gate(candidate)

    assert out["decision"] == "PASS"
    assert out["candidate"]["sample_count"] == 96
    assert out["inputs"]["source"] == "backtest"


def _alpha_candidate() -> dict:
    return {
        "id": "trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234",
        "source": "alpha_framework",
        "config": {"alphaFramework": {"allocation": {"weights": {}}}},
        "metadata": {
            "status": "completed",
            "target": "sandbox",
            "sample_count": 96,
            "regime_counts": {"bull": 24, "bear": 24, "volatile": 24, "sideways": 24},
        },
    }


def _evidence_bundle(candidate_id: str | None = "trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234") -> dict:
    return {
        "candidate_id": candidate_id,
        "backtest": {
            "mode": "B",
            "total_trades": 120,
            "sharpe": 1.2,
            "profit_factor": 1.5,
            "max_drawdown": 0.1,
            "absolute_confidence": "moderate",
            "sanity_flags": [],
            "parity_audit": {"worker_parity": {"decision": "PASS", "drift_rate": 0.0}},
        },
        "monte_carlo": {
            "source": "backtest",
            "n_trades": 120,
            "simulation_method": "block_bootstrap",
            "mdd_95th": 0.16,
            "go_live_verdict": "PASS",
        },
        "pbo": {
            "source": "backtest",
            "n_trades": 120,
            "method": "cscv_rank_logit",
            "pbo": 0.31,
            "oos_mean_return": 0.03,
            "go_live_verdict": "PASS",
        },
    }


def test_alpha_policy_evidence_gate_passes_candidate_specific_bundle():
    out = evaluate_alpha_policy_evidence_gate(_alpha_candidate(), _evidence_bundle())

    assert out["decision"] == "PASS"
    assert out["inputs"]["source"] == "evidence_bundle"
    assert out["inputs"]["candidate_id"] == _alpha_candidate()["id"]


def test_alpha_policy_evidence_gate_rejects_mismatched_candidate_id():
    out = evaluate_alpha_policy_evidence_gate(_alpha_candidate(), _evidence_bundle(candidate_id="wrong"))

    assert out["decision"] == "FAIL"
    assert "alpha_evidence_candidate_mismatch" in out["failed_gates"]


def test_build_alpha_policy_evidence_bundle_normalizes_artifact_shapes():
    bundle = build_alpha_policy_evidence_bundle(
        candidate_id=_alpha_candidate()["id"],
        backtest={
            "raw_results": json.dumps({
                "mode": "B",
                "summary": {"total_trades": 120, "sharpe": 1.2, "profit_factor": 1.5, "max_drawdown": 0.1},
                "parity_audit": {"worker_parity": {"decision": "PASS"}},
                "sanity_flags": [],
                "absolute_confidence": "moderate",
            })
        },
        monte_carlo={
            "source": "backtest",
            "n_trades": 120,
            "mdd_95th": 0.16,
            "go_live_verdict": "PASS",
            "raw_distribution": json.dumps({"simulation_method": "block_bootstrap"}),
        },
        pbo={
            "source": "backtest",
            "n_trades": 120,
            "pbo": 0.31,
            "oos_mean_return": 0.03,
            "go_live_verdict": "PASS",
            "raw_details": json.dumps({"method": "cscv_rank_logit"}),
        },
    )

    assert bundle["candidate_id"] == _alpha_candidate()["id"]
    assert bundle["backtest"]["mode"] == "B"
    assert bundle["backtest"]["total_trades"] == 120
    assert bundle["monte_carlo"]["simulation_method"] == "block_bootstrap"
    assert bundle["pbo"]["method"] == "cscv_rank_logit"
