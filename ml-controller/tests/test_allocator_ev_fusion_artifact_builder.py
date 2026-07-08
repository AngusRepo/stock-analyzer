from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.allocator_ev_fusion_artifact_builder import (  # noqa: E402
    build_allocator_ev_fusion_artifact_from_rows,
    load_allocator_ev_fusion_training_rows,
)
from services.allocator_ev_feature_snapshot_backfill import (  # noqa: E402
    build_allocator_ev_feature_snapshots_for_date,
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
    assert "s12_available" in artifact["coefficients"]
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
    observed = []

    def query_fn(sql: str, params: list[object]) -> list[dict]:
        observed.append({"sql": sql, "params": params})
        return []

    rows = load_allocator_ev_fusion_training_rows(query_fn, end_date="2026-07-07", lookback_days=45, limit=123)

    assert rows == []
    assert len(observed) == 2
    assert "allocator_ev_feature_snapshots fs" in observed[0]["sql"]
    assert "dr.alpha_allocation" in observed[1]["sql"]
    assert "NULL AS market_heat_expected_return" in observed[1]["sql"]
    assert "dr.market_heat_expected_return" not in observed[1]["sql"]
    assert "p.verified_at IS NOT NULL" in observed[1]["sql"]
    assert observed[0]["params"] == ["2026-07-07", "2026-07-07", "-45 days", 123]
    assert observed[1]["params"] == ["2026-07-07", "2026-07-07", "-45 days", 123]


def test_load_allocator_ev_fusion_training_rows_prefers_asof_snapshot_rows():
    snapshot_row = {
        "stock_id": 1,
        "symbol": "2330",
        "prediction_date": "2026-07-07",
        "actual_return_pct": 0.01,
        "alpha_allocation": json.dumps({
            "l4_alpha_ev": _l4_payload(0.02),
            "s12_trade_ev": _s12_payload(0.01),
        }),
        "allocator_ev_feature_snapshot_source": "allocator_ev_asof_backfill_v1",
    }
    duplicate_daily_row = {
        **snapshot_row,
        "alpha_allocation": json.dumps({"legacy": True}),
    }
    other_daily_row = {
        **snapshot_row,
        "stock_id": 2,
        "symbol": "2317",
        "alpha_allocation": json.dumps({
            "l4_alpha_ev": _l4_payload(0.015),
            "s12_trade_ev": _s12_payload(0.005),
        }),
    }

    def query_fn(sql: str, _params: list[object]) -> list[dict]:
        if "allocator_ev_feature_snapshots fs" in sql:
            return [snapshot_row]
        return [duplicate_daily_row, other_daily_row]

    rows = load_allocator_ev_fusion_training_rows(query_fn, end_date="2026-07-07", lookback_days=45, limit=123)

    assert rows == [snapshot_row, other_daily_row]


def test_load_allocator_ev_fusion_training_rows_falls_back_when_snapshot_table_missing():
    daily_row = {
        "stock_id": 1,
        "symbol": "2330",
        "prediction_date": "2026-07-07",
        "actual_return_pct": 0.01,
        "alpha_allocation": json.dumps({
            "l4_alpha_ev": _l4_payload(0.02),
            "s12_trade_ev": _s12_payload(0.01),
        }),
    }

    def query_fn(sql: str, _params: list[object]) -> list[dict]:
        if "allocator_ev_feature_snapshots fs" in sql:
            raise RuntimeError("no such table: allocator_ev_feature_snapshots")
        return [daily_row]

    rows = load_allocator_ev_fusion_training_rows(query_fn, end_date="2026-07-07", lookback_days=45, limit=123)

    assert rows == [daily_row]


def test_allocator_ev_feature_snapshot_backfill_dry_run_uses_previous_day_l4_artifact():
    l4_training_rows = []
    for day_idx in range(30):
        day = f"2026-06-{day_idx + 1:02d}"
        for symbol_idx in range(24):
            score = 45 + (symbol_idx % 35)
            ml_edge = 8 + (symbol_idx % 15)
            fundamental = 10 + (symbol_idx % 12)
            chip = 9 + (symbol_idx % 14)
            technical = 11 + (symbol_idx % 13)
            target = (
                (score / 100.0) * 0.025
                + (ml_edge / 25.0) * 0.012
                + (technical / 25.0) * 0.008
                - 0.015
            )
            l4_training_rows.append({
                "stock_id": symbol_idx,
                "symbol": f"{symbol_idx:04d}",
                "prediction_date": day,
                "forecast_data": json.dumps({
                    "ensemble_v2": {
                        "avg_rank": 0.25 + (symbol_idx % 10) * 0.04,
                        "confidence": 0.55 + (symbol_idx % 8) * 0.03,
                    }
                }),
                "actual_return_pct": target,
                "score": score,
                "score_components": json.dumps({
                    "finalScore": score,
                    "components": {
                        "mlEdge": ml_edge,
                        "fundamentalQuality": fundamental,
                        "chipFlow": chip,
                        "technicalStructure": technical,
                    },
                }),
            })
    candidate = {
        "stock_id": 1,
        "symbol": "2330",
        "recommendation_date": "2026-07-07",
        "forecast_data": json.dumps({
            "ensemble_v2": {"avg_rank": 0.35, "confidence": 0.72},
        }),
        "score": 70,
        "score_components": json.dumps({
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "alpha_context": json.dumps({
            "market_heat_expected_return": 0.003,
            "edge_bucket": "breakout_vol_expansion",
        }),
        "existing_alpha_allocation": json.dumps({"selected": True}),
        "current_price": 100,
    }

    def query_fn(sql: str, params: list[object] | None = None) -> list[dict]:
        if "FROM predictions p" in sql and "JOIN daily_recommendations dr" in sql:
            assert params[0] == "2026-07-06"
            return l4_training_rows
        if "FROM s12_replay_trade_outcomes" in sql:
            return []
        if "FROM s12_structure_snapshots" in sql:
            return [{
                "symbol": "2330",
                "trade_date": "2026-07-07",
                "entry_price": 100,
                "structure_stop": 97,
                "target1_price": 104,
                "target2_price": 108,
                "ready": 1,
                "state": "reaction_ready",
            }]
        if "FROM daily_recommendations dr" in sql and "JOIN predictions p" in sql:
            return [candidate]
        return []

    result = build_allocator_ev_feature_snapshots_for_date(
        snapshot_date="2026-07-07",
        query_fn=query_fn,
        dry_run=True,
        l4_min_samples=200,
        l4_min_dates=20,
    )

    assert result["status"] == "ok"
    assert result["l4"]["trained_until"] == "2026-07-06"
    assert result["snapshots_built"] == 1
    assert result["written"] == 0


def test_allocator_ev_feature_snapshot_backfill_reuses_persisted_candidate_time_payloads():
    l4_training_rows = []
    for day_idx in range(30):
        day = f"2026-06-{day_idx + 1:02d}"
        for symbol_idx in range(24):
            l4_training_rows.append({
                "stock_id": symbol_idx,
                "symbol": f"{symbol_idx:04d}",
                "prediction_date": day,
                "forecast_data": json.dumps({
                    "ensemble_v2": {"avg_rank": 0.30, "confidence": 0.70}
                }),
                "actual_return_pct": 0.01 + (symbol_idx % 10) * 0.001,
                "score": 60 + symbol_idx % 10,
                "score_components": json.dumps({
                    "finalScore": 60 + symbol_idx % 10,
                    "components": {
                        "mlEdge": 15,
                        "fundamentalQuality": 16,
                        "chipFlow": 17,
                        "technicalStructure": 18,
                    },
                }),
            })
    persisted = {
        "selected": True,
        "l4_alpha_ev": {
            **_l4_payload(0.021),
            "trained_until": "2026-07-06",
        },
        "s12_trade_ev": _s12_payload(0.009),
    }
    candidate = {
        "stock_id": 1,
        "symbol": "2330",
        "recommendation_date": "2026-07-07",
        "forecast_data": json.dumps({"ensemble_v2": {"avg_rank": 0.35, "confidence": 0.72}}),
        "score": 70,
        "score_components": json.dumps({
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "alpha_context": json.dumps({"market_heat_expected_return": 0.003}),
        "existing_alpha_allocation": json.dumps(persisted),
        "current_price": 100,
    }

    def query_fn(sql: str, params: list[object] | None = None) -> list[dict]:
        if "FROM predictions p" in sql and "JOIN daily_recommendations dr" in sql:
            assert params[0] == "2026-07-06"
            return l4_training_rows
        if "FROM s12_replay_trade_outcomes" in sql:
            return []
        if "FROM s12_structure_snapshots" in sql:
            return []
        if "FROM daily_recommendations dr" in sql and "JOIN predictions p" in sql:
            return [candidate]
        return []

    result = build_allocator_ev_feature_snapshots_for_date(
        snapshot_date="2026-07-07",
        query_fn=query_fn,
        dry_run=True,
        l4_min_samples=200,
        l4_min_dates=20,
    )

    assert result["snapshots_built"] == 1
    assert result["reused_l4_payloads"] == 1
    assert result["reused_s12_payloads"] == 1
    assert result["skip_reasons"] == {}


def test_allocator_ev_fusion_artifact_builder_keeps_explicit_s12_invalid_payload_as_unavailable_feature():
    rows = []
    for day_idx in range(26):
        day = f"2026-06-{day_idx + 1:02d}"
        for symbol_idx in range(24):
            l4 = 0.004 + (symbol_idx % 12) * 0.001
            has_s12 = symbol_idx % 3 != 0
            s12_payload = (
                _s12_payload(0.002 + (symbol_idx % 8) * 0.0008)
                if has_s12
                else {
                    "schema_version": "s12-trade-ev-v1",
                    "status": "invalid_structure",
                    "semantic": "trade_expected_return_not_5bar_close_forecast",
                    "trade_expected_return_source": "s12_structural_cold_start_ev_missing_long_structure_stop",
                    "s12_structural_targets": {"target_quality_state": "unknown"},
                    "candidate_s12_entry_context": {"detail_available": True, "ready": False},
                }
            )
            rows.append({
                "symbol": f"{symbol_idx:04d}",
                "prediction_date": day,
                "actual_return_pct": l4 + (0.004 if has_s12 else -0.003),
                "alpha_allocation": json.dumps({
                    "l4_alpha_ev": _l4_payload(l4),
                    "s12_trade_ev": s12_payload,
                }),
            })

    out = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-07-07",
        min_samples=200,
        min_dates=20,
    )

    audit = out["artifact"]["validation_packet"]["sample_audit"]
    assert audit["sample_count"] == len(rows)
    assert audit["missing_feature_rows"] == 0
    assert "s12_available" in out["artifact"]["feature_names"]
