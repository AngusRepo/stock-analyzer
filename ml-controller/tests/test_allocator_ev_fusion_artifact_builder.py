from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.allocator_ev_fusion_artifact_builder import (  # noqa: E402
    build_allocator_ev_fusion_artifact_from_rows,
    load_allocator_ev_fusion_training_rows,
)


def _l4_payload(value: float) -> dict:
    return {
        "schema_version": "l4-alpha-ev-v1",
        "expected_return_owner": "l4_alpha_ev",
        "expected_return_mean": value,
        "expected_return_source": "l4_alpha_ev:test",
        "promotion_state": "production_approved",
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "resolver_method": "test_meta_calibrator",
        "model_version": "l4-test",
        "feature_snapshot_version": "l4-features-test",
        "trained_until": "2026-07-01",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
    }


def _s12_payload(value: float, *, ready: bool = True) -> dict:
    return {
        "schema_version": "s12-trade-ev-v1",
        "status": "loaded",
        "semantic": "trade_expected_return_not_5bar_close_forecast",
        "trade_expected_return_net_pct": value,
        "trade_expected_return_source": "s12_replay_trade_outcomes",
        "bootstrap_scope": "symbol",
        "sample_policy": "verified_s12_symbol_replay",
        "s12_structural_targets": {
            "target_quality_state": "structure_targets" if ready else "partial_structure_target",
            "reward_confidence_multiplier": 0.95 if ready else 0.7,
        },
        "candidate_s12_entry_context": {"detail_available": True, "ready": ready},
    }


def _row(day: str, idx: int) -> dict:
    l4 = -0.008 + (idx % 25) * 0.0015
    s12 = -0.004 + (idx % 20) * 0.0012
    ready = idx % 7 != 0
    target = (0.55 * l4) + (0.35 * s12) + (0.004 if ready else -0.002)
    return {
        "symbol": f"{idx:04d}",
        "prediction_date": day,
        "actual_return_pct": target,
        "alpha_context": json.dumps({"market_heat_expected_return": 0.003 + (idx % 5) * 0.0005}),
        "alpha_allocation": json.dumps({
            "l4_alpha_ev": _l4_payload(l4),
            "s12_trade_ev": _s12_payload(s12, ready=ready),
        }),
    }


def test_allocator_ev_fusion_artifact_builder_emits_production_artifact_when_oos_passes():
    rows = []
    for day_idx in range(32):
        day = f"2026-05-{day_idx + 1:02d}"
        for symbol_idx in range(24):
            rows.append(_row(day, symbol_idx))

    out = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-07-07",
        min_samples=200,
        min_dates=20,
        l2=0.15,
    )

    artifact = out["artifact"]
    assert out["status"] == "ok"
    assert artifact["expected_return_owner"] == "allocator_ev_fusion"
    assert artifact["promotion_state"] == "production_approved"
    assert artifact["validation_packet"]["decision"] == "PASS"
    assert artifact["resolver_method"] == "ridge_allocator_ev_fusion"
    assert "l4_expected_return" in artifact["coefficients"]
    assert "s12_trade_expected_return" in artifact["coefficients"]
    assert artifact["coefficients"]["l4_expected_return"] != 0
    assert artifact["coefficients"]["s12_trade_expected_return"] != 0


def test_allocator_ev_fusion_artifact_builder_fails_closed_on_insufficient_samples():
    rows = [_row("2026-05-01", idx) for idx in range(10)]

    out = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-07-07",
        min_samples=200,
        min_dates=20,
    )

    artifact = out["artifact"]
    assert out["status"] == "failed_validation"
    assert artifact["promotion_state"] == "approval_required"
    assert artifact["validation_packet"]["decision"] == "FAIL"
    assert "insufficient_samples" in artifact["validation_packet"]["failed_gates"]


def test_load_allocator_ev_fusion_training_rows_queries_verified_allocation_evidence():
    observed = {}

    def query_fn(sql: str, params: list[object]) -> list[dict]:
        observed["sql"] = sql
        observed["params"] = params
        return []

    rows = load_allocator_ev_fusion_training_rows(query_fn, end_date="2026-07-07", lookback_days=45, limit=123)

    assert rows == []
    assert "dr.alpha_allocation" in observed["sql"]
    assert "p.verified_at IS NOT NULL" in observed["sql"]
    assert observed["params"] == ["2026-07-07", "2026-07-07", "-45 days", 123]
