from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.pbo_audit_store import build_pbo_audit_insert, persist_pbo_audit  # noqa: E402


def _audit() -> dict:
    return {
        "method": "cscv_rank_logit",
        "pbo": 0.25,
        "go_live_verdict": "PASS",
        "verdict_reason": "ok",
        "n_partitions": 6,
        "n_combinations": 20,
        "n_candidates": 12,
        "oos_mean_return": 0.03,
        "degradation": 0.02,
        "selected_strategy_counts": {"trial_1": 4},
    }


def test_build_pbo_audit_insert_maps_optuna_l2_audit_to_pbo_results_schema():
    sql, params = build_pbo_audit_insert(
        run_date="2026-04-26",
        source="optuna_l2",
        audit=_audit(),
    )

    assert "INSERT OR REPLACE INTO pbo_results" in sql
    assert params[:6] == ["2026-04-26", "optuna_l2", 6, 20, 0, 0.25]
    raw = json.loads(params[-1])
    assert raw["method"] == "cscv_rank_logit"
    assert raw["n_candidates"] == 12
    assert raw["origin"] == "optuna_l2"


def test_persist_pbo_audit_uses_d1_execute(monkeypatch):
    calls = []

    def fake_execute(sql, params=None, timeout=60.0):
        calls.append((sql, params, timeout))
        return {"success": True, "meta": {"changes": 1}}

    import services.pbo_audit_store as store

    monkeypatch.setattr(store, "execute", fake_execute)

    out = persist_pbo_audit(
        run_date="2026-04-26",
        source="optuna_l2",
        audit=_audit(),
    )

    assert out["status"] == "success"
    assert calls[0][1][1] == "optuna_l2"
