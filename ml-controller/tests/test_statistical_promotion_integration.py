from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import promotion_service  # noqa: E402
from services.validation_governance import hansen_spa_reality_check  # noqa: E402


@pytest.mark.parametrize("alpha_policy", [False, True])
def test_complete_versioned_search_evidence_can_pass_latest_gate(monkeypatch, alpha_policy):
    correction = hansen_spa_reality_check(
        {"champion": [0.001] * 40, "candidate": [0.02, 0.018, 0.021, 0.019] * 10},
        n_bootstrap=200, search_candidate_ids=["candidate"],
    )
    import hashlib
    distribution = [-0.08, -0.03, 0.0, 0.02, 0.04, 0.06, 0.09, 0.12]
    payload = json.dumps(distribution, separators=(",", ":"))
    dsr = {
        "return_series": [0.018, 0.011, -0.006, 0.014, 0.009, -0.004, 0.016, 0.012, -0.005, 0.013] * 12,
        "trial_sharpe_distribution": distribution,
        "effective_trials": len(distribution),
        "trial_distribution_lineage": {"artifact_id": "synthetic-test-trials", "as_of_date": "2026-09-26", "pit_fenced": True, "payload_checksum": hashlib.sha256(payload.encode()).hexdigest()},
    }
    rows = {
        "backtest_results": [{
            "run_date": "2026-09-26", "strategy": "mode-b", "total_trades": 120,
            "sharpe": 1.2, "profit_factor": 1.5, "max_drawdown": 0.1,
            "raw_results": json.dumps({
                "mode": "B", "summary": {"total_trades": 120}, **dsr,
                "per_regime": {"bull": {"trades": 40, "return": 0.08}, "sideways": {"trades": 30, "return": 0.03}},
                "parity_audit": {"worker_parity": {"decision": "PASS"}},
                "sanity_flags": [], "absolute_confidence": "moderate",
                "walk_forward": {"passed": True, "windows": 6}, "data_snooping": correction,
            }),
        }],
        "monte_carlo_results": [{
            "source": "backtest", "n_trades": 120, "mdd_95th": 0.16, "go_live_verdict": "PASS",
            "raw_distribution": json.dumps({"simulation_method": "block_bootstrap", "block_size": 10}),
        }],
        "pbo_results": [{
            "source": "backtest", "n_trades": 120, "pbo": 0.31, "oos_mean_return": 0.03,
            "go_live_verdict": "PASS", "raw_details": json.dumps({"method": "cscv_rank_logit"}),
        }],
    }

    def fake_query(sql, params=None, timeout=60.0):
        return next(values for table, values in rows.items() if table in sql)

    monkeypatch.setattr(promotion_service, "query", fake_query)
    if alpha_policy:
        candidate = {
            "status": "completed", "target": "sandbox", "sample_count": 96,
            "regime_counts": {"bull": 24, "bear": 24, "volatile": 24, "sideways": 24},
            "alphaFramework": {"allocation": {"weights": {}}},
        }
        out = promotion_service.evaluate_latest_alpha_policy_gate(candidate)
    else:
        out = promotion_service.evaluate_latest_promotion_gate()
    assert out["decision"] == "PASS"
    gate = next(g for g in out["validation_packet"]["gates"] if g["name"] == "data_snooping_overfit_guard")
    assert gate["status"] == "PASS"
    assert gate["evidence"]["contract_errors"] == []
