from __future__ import annotations

import inspect
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.allocator_ev_fusion_artifact_builder import (  # noqa: E402
    _feature_vector,
    _paired_canonical_l4_comparison,
    _samples,
    build_allocator_ev_fusion_artifact_from_rows,
    load_allocator_ev_fusion_training_rows,
)
from services.allocator_ev_feature_snapshot_backfill import (  # noqa: E402
    build_allocator_ev_feature_snapshots_for_date,
    load_allocator_ev_snapshot_candidate_rows,
)

from services.l4_alpha_ev_resolver import (  # noqa: E402
    SNAPSHOT_BACKFILL_AS_OF_GUARD,
    SNAPSHOT_BACKFILL_SOURCE,
    SNAPSHOT_BACKFILL_USAGE_SCOPE,
)
from services.ev_lineage_contract import prediction_timing_blockers  # noqa: E402
from services.active8_score_semantics import MODEL_TARGET_SEMANTIC_VERSION  # noqa: E402


def _l4_payload(value: float) -> dict:
    return {
        "schema_version": "l4-alpha-ev-v1",
        "artifact_contract_version": "l4-alpha-ev-contract-v4",
        "feature_semantic_version": "l4-directional-score-components-v2-lineage-bound",
        "label_schema_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "expected_return_owner": "l4_alpha_ev",
        "expected_return_mean": value,
        "expected_return_source": "l4_alpha_ev:test",
        "promotion_state": "production_approved",
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "resolver_method": "test_meta_calibrator",
        "model_version": "l4-test",
        "feature_snapshot_version": "l4-directional-score-components-v2-lineage-bound",
        "trained_until": "2026-01-01",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
    }


def _ensemble_forecast(avg_rank: float = 0.65, confidence: float = 0.72) -> str:
    return json.dumps({
        "ensemble_v2": {
            "semantic_version": "active8-ic-weighted-rank-v4",
            "contributing_models": ["LightGBM", "XGBoost"],
            "artifact_versions": {"LightGBM": "vTest", "XGBoost": "vTest"},
            "model_set_signature": "LightGBM@vTest|XGBoost@vTest",
            "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
            "avg_rank": avg_rank,
            "confidence": confidence,
        },
    })


def _champion_history_rows() -> list[dict]:
    return [
        {
            "model_name": model_name,
            "version": "vTest",
            "artifact_id": f"{model_name}:vTest",
            "effective_at": "2026-01-01T00:00:00Z",
            "retired_at": None,
            "source": "model_champion_history",
            "evidence_grade": "exact",
            "evidence_json": "{}",
        }
        for model_name in ("LightGBM", "XGBoost")
    ]


def _s12_payload(value: float, *, ready: bool = True) -> dict:
    return {
        "schema_version": "s12-trade-ev-v1",
        "status": "loaded",
        "semantic": "trade_expected_return_not_5bar_close_forecast",
        "trade_expected_return_net_pct": value,
        "trade_expected_return_source": "s12_replay_trade_outcomes",
        "bootstrap_scope": "symbol",
        "sample_policy": "verified_s12_symbol_replay",
        "entry_price": 100.0,
        "stop_price": 96.0,
        "target1_price": 104.0,
        "target2_price": 108.0,
        "s12_structural_targets": {
            "target_quality_state": "structure_targets" if ready else "partial_structure_target",
            "reward_confidence_multiplier": 0.95 if ready else 0.7,
            "structure_stop_source": "s12_structure_snapshots.structure_stop",
        },
        "candidate_s12_entry_context": {"detail_available": True, "ready": ready},
    }


def _row(day: str, idx: int) -> dict:
    day_number = int(day[-2:])
    regime = ("bull", "sideways", "bear", "volatile")[day_number % 4]
    regime_surface = {name: 1.0 if name == regime else 0.0 for name in ("bull", "bear", "volatile", "sideways")}
    market_return_5d = ((day_number % 9) - 4) * 0.004
    l4 = -0.008 + (idx % 25) * 0.0015
    s12 = -0.004 + (idx % 20) * 0.0012
    ready = idx % 7 != 0
    target = (0.55 * l4) + (0.35 * s12) + (0.004 if ready else -0.002)
    replay_executed = ready and idx % 5 != 0
    replay_pnl = target + (0.4 * s12) + 0.002 if replay_executed else None
    return {
        "symbol": f"{idx:04d}",
        "prediction_date": day,
        "label_adjustment_source": "stock_prices:finlab_primary_canonical_mirror",
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 50.0 + (idx % 20),
            "components": {
                "mlEdge": 10.0 + (idx % 10),
                "fundamentalQuality": 12.0,
                "chipFlow": 11.0,
                "technicalStructure": 13.0,
            },
        }),
        "forecast_data": _ensemble_forecast(0.35 + (idx % 20) * 0.02),
        "actual_return_pct": target + 0.25,
        "l4_executable_return_pct": target,
        "trade_pnl_pct": target + (0.4 * s12) + (0.002 if ready else -0.001),
        "s12_replay_pnl_pct": replay_pnl,
        "s12_replay_status": "executed" if replay_executed else "not_triggered",
        "alpha_context": json.dumps({
            "market_heat_expected_return": 0.003 + (idx % 5) * 0.0005,
            "market_regime_context": {
                "schema_version": "fusion-market-context-pit-v1",
                "signal_date": day,
                "source_date": day,
                "source": "test_point_in_time_market_context",
                "market_segment": "LISTED",
                "market_return_1d": market_return_5d / 5.0,
                "market_return_5d": market_return_5d,
                "market_bias_20d": market_return_5d * 1.5,
                "risk_score": 20.0 + (day_number % 6) * 10.0,
                "advance_ratio": 0.45 + (day_number % 4) * 0.04,
                "bull_alignment_pct": 0.40 + (day_number % 3) * 0.08,
                "regime_surface": regime_surface,
                "reconstruction": "test_native",
            },
            "pit_sector_alpha_expert": {
                "status": "loaded",
                "point_in_time": True,
                "features": {
                    "sector_alpha_available": 1.0,
                    "sector_formal_rs_rank": 0.4,
                    "sector_thematic_rs_rank": 0.45,
                    "sector_rs_consensus": 0.42,
                    "sector_momentum_consensus": 0.1,
                    "sector_rotation_consensus": 0.05,
                    "sector_flow_consensus": 0.08,
                    "sector_cross_layer_dispersion": 0.02,
                    "sector_breadth_balance": 0.1,
                    "sector_breadth_available": 1.0,
                    "sector_participation_acceleration": 0.03,
                    "sector_participation_available": 1.0,
                    "sector_membership_coverage": 0.9,
                },
            },
        }),
        "alpha_allocation": json.dumps({
            "l4_alpha_ev": _l4_payload(l4),
            "s12_trade_ev": _s12_payload(s12, ready=ready),
        }),
    }


def test_allocator_ev_fusion_artifact_builder_emits_production_artifact_when_oos_passes():
    rows = []
    for day_idx in range(48):
        day = (date(2026, 4, 1) + timedelta(days=day_idx)).isoformat()
        for symbol_idx in range(64):
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
    assert artifact["promotion_state"] == "production_primary"
    assert artifact["promotion_tier"] == "primary"
    assert artifact["primary_expected_return_allowed"] is True
    assert artifact["validation_packet"]["decision"] == "PASS"
    packet = artifact["validation_packet"]
    assert packet["schema_version"] == "allocator-ev-fusion-validation-packet-v14"
    assert set(packet["gate_layers"]) == {
        "data_validity", "forecast_skill", "statistical_validity", "economic_utility"
    }
    assert packet["gate_layers"]["forecast_skill"]["primary_score"] == (
        "residual_oos_corr_and_spread_lcb90"
    )
    assert packet["validation_scope"]["effective_sample_unit"] == "prediction_date"
    assert packet["validation_scope"]["base_expected_return_owner"] == "l4_alpha_ev"
    assert packet["validation_scope"]["residual_target"] == (
        "canonical_five_session_net_return_minus_point_in_time_l4_alpha_ev"
    )
    assert packet["sample_audit"]["l4_available_count"] > 0
    assert packet["sample_audit"]["candidate_time_s12_feature_count"] == 0
    assert packet["promotion"]["tier"] == "primary"
    assert artifact["schema_version"] == "allocator-ev-fusion-artifact-v14"
    assert artifact["artifact_contract_version"] == "allocator-ev-fusion-contract-v14"
    assert artifact["resolver_method"] == "day_t_causal_l4_residual_overlay"
    assert artifact["policy_value_head_count"] == 1
    assert artifact["policy_value_heads"] == ["residual_adjustment_model"]
    assert artifact["residual_adjustment_model"]["decision"] == "PASS"
    assert artifact["residual_adjustment_model"]["target"] == "residual_target"
    assert "coefficients" not in artifact
    assert "selection_model" not in artifact
    assert "conditional_execution_return_model" not in artifact
    assert "execution_probability_model" not in artifact
    selection_diagnostic = packet["selection_diagnostic_model_not_served"]
    assert selection_diagnostic["decision"] == "PASS"
    assert packet["shadow_diagnostics"]["promotion_effect"] is False
    assert packet["champion_comparison"]["decision"] == "PASS"
    assert packet["champion_comparison"]["top_trade_ev_lcb90"] > 0
    l4_base = packet["l4_base_comparison"]
    assert l4_base["baseline_artifact_id"] == "allocator_ev_fusion:canonical-l4-base-v14"
    assert l4_base["artifact_contract_version"] == artifact["artifact_contract_version"]
    assert l4_base["policy_value_head_count"] == artifact["policy_value_head_count"]
    assert l4_base["comparison_panel_id"] == packet["benchmark_panel"]["panel_id"]
    assert l4_base["same_oof_rows_and_dates_required"] is True
    assert l4_base["baseline_owner"] == "l4_alpha_ev"
    assert l4_base["challenger_top_trade_ev_lcb90"] > 0
    assert l4_base["decision"] == "PASS"
    assert artifact["comparison_baseline_artifact_id"] == l4_base["baseline_artifact_id"]
    assert artifact["validation_packet"]["sample_audit"]["market_context_available_coverage"] == 1.0
    assert "market_return_5d" in artifact["feature_names"]
    assert "l4_defensive_regime_interaction" in artifact["feature_names"]

def test_allocator_ev_fusion_multiple_testing_fails_closed_without_corrected_evidence():
    rows = [
        _row((date(2026, 4, 1) + timedelta(days=day_idx)).isoformat(), symbol_idx)
        for day_idx in range(48)
        for symbol_idx in range(64)
    ]

    rejected = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-07-07",
        min_samples=200,
        min_dates=20,
        l2=0.15,
        search_trial_count=24,
    )

    rejected_artifact = rejected["artifact"]
    assert rejected["status"] == "failed_validation"
    assert rejected_artifact["promotion_tier"] == "shadow"
    assert rejected_artifact["validation_packet"]["gate_layers"]["statistical_validity"]["decision"] == "FAIL"
    assert "multiple_testing:approved_correction_missing" in rejected_artifact["validation_packet"]["failed_gates"]

    corrected = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-07-07",
        min_samples=200,
        min_dates=20,
        l2=0.15,
        search_trial_count=24,
        multiple_testing_evidence={
            "method": "hansen_spa",
            "passed": True,
            "adjusted_p_value": 0.04,
        },
    )

    corrected_artifact = corrected["artifact"]
    assert corrected["status"] == "ok"
    assert corrected_artifact["promotion_tier"] == "primary"
    assert corrected_artifact["validation_packet"]["gate_layers"]["statistical_validity"]["decision"] == "PASS"


def test_allocator_ev_fusion_benchmark_panel_identity_mismatch_fails_closed():
    rows = [
        _row((date(2026, 4, 1) + timedelta(days=day_idx)).isoformat(), symbol_idx)
        for day_idx in range(48)
        for symbol_idx in range(64)
    ]

    out = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-07-07",
        min_samples=200,
        min_dates=20,
        l2=0.15,
        benchmark_panel_id="fusion-panel-v1:stale-panel",
    )



def test_fusion_challenger_must_beat_canonical_l4_on_paired_oos_dates():
    samples = []
    for day_idx in range(20):
        for idx in range(20):
            target = -0.02 + idx * 0.002
            samples.append({
                "date": f"2026-06-{day_idx + 1:02d}",
                "selection_target": target,
                "features": {
                    "l4_available": 1.0,
                    "l4_expected_return": target,
                    "technical_structure_norm": float(20 - idx) / 20.0,
                },
            })

    comparison = _paired_canonical_l4_comparison(
        samples,
        fusion_intercept=0.0,
        fusion_coefficients={"technical_structure_norm": 1.0},
    )

    assert comparison["decision"] == "FAIL"
    assert comparison["oos_date_count"] == 5
    assert "fusion_corr_delta_lcb90_inferior_to_canonical_l4" in comparison["failed_gates"]
    assert "fusion_spread_delta_lcb90_inferior_to_canonical_l4" in comparison["failed_gates"]


def test_fusion_purged_oof_uses_snapshot_date_and_recorded_market_lineage():
    rows = []
    for idx in range(20):
        row = _row("2026-05-01", idx)
        row["snapshot_date"] = row.pop("prediction_date")
        row["generation_mode"] = "purged_oof"
        row["label_adjustment_source"] = "canonical_market_daily:finlab.price"
        forecast = json.loads(row["forecast_data"])
        forecast["ensemble_v2"].update({
            "generation_mode": "purged_oof",
            "semantic_version": "active8-purged-oof-chronological-ridge-v3",
        })
        row["forecast_data"] = json.dumps(forecast)
        rows.append(row)

    samples, audit = _samples(rows)
    assert len(samples) == 20
    assert audit["date_count"] == 1
    assert audit["raw_date_counts"] == {"2026-05-01": 20}
    assert audit["invalid_reason_counts"] == {}
    assert audit["generation_mode_counts"] == {"purged_oof": 20}
    assert audit["evidence_max_date"] == "2026-05-01"
    assert audit["oof_max_date"] == "2026-05-01"


def test_allocator_ev_fusion_selection_target_deducts_roundtrip_cost_exactly_once():
    row = _row("2026-06-01", 1)
    row["l4_executable_return_pct"] = 0.03

    samples, audit = _samples(
        [row],
        execution_cost_bps=18.0,
        min_cross_section_samples_per_date=1,
    )

    assert audit["sample_count"] == 1
    assert samples[0]["actual_return_target"] == pytest.approx(0.0282)
    assert samples[0]["selection_target"] == pytest.approx(0.0)
    assert "CANONICAL_ROUNDTRIP_COST_RATE" not in inspect.getsource(
        load_allocator_ev_fusion_training_rows
    )


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
    assert artifact["promotion_state"] == "shadow"
    assert artifact["promotion_tier"] == "shadow"
    assert artifact["primary_expected_return_allowed"] is False
    assert artifact["validation_packet"]["decision"] == "FAIL"
    assert "residual_adjustment:insufficient_samples" in artifact["validation_packet"]["failed_gates"]


def test_allocator_ev_fusion_stays_shadow_until_primary_evidence_floor():
    rows = [
        _row(f"2026-06-{day_idx + 1:02d}", symbol_idx)
        for day_idx in range(20)
        for symbol_idx in range(64)
    ]

    out = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-07-14",
        min_samples=500,
        min_dates=20,
        l2=0.15,
    )

    artifact = out["artifact"]
    assert out["status"] == "ok"
    assert artifact["promotion_tier"] == "shadow"
    assert artifact["promotion_state"] == "shadow"
    assert artifact["primary_expected_return_allowed"] is False
    assert artifact["validation_packet"]["decision"] == "PASS"
    assert "primary_insufficient_dates" in artifact["promotion_blockers"]


def test_allocator_ev_fusion_artifact_builder_keeps_missing_replay_labels_shadow_only():
    rows = []
    for day_idx in range(6):
        day = f"2026-06-{day_idx + 1:02d}"
        for symbol_idx in range(140):
            l4 = -0.01 + (symbol_idx % 40) * 0.001
            s12 = 0.004 + (symbol_idx % 8) * 0.0005
            rows.append({
                "symbol": f"{symbol_idx:04d}",
                "prediction_date": day,
                "score_components": json.dumps({
                    "version": "score_v2",
                    "semanticVersion": "score-v2-active8-components-v3",
                    "finalScore": 60,
                    "components": {
                        "mlEdge": 15,
                        "fundamentalQuality": 15,
                        "chipFlow": 15,
                        "technicalStructure": 15,
                    },
                }),
                "forecast_data": _ensemble_forecast(),
                "actual_return_pct": 0.25,
                "l4_executable_return_pct": (0.6 * l4) + (0.4 * s12),
                "trade_pnl_pct": (0.6 * l4) + (0.7 * s12),
                "alpha_allocation": json.dumps({
                    "l4_alpha_ev": _l4_payload(l4),
                    "s12_trade_ev": _s12_payload(s12, ready=True),
                }),
            })

    out = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-07-07",
        min_samples=500,
        min_dates=5,
        l2=0.15,
    )

    artifact = out["artifact"]
    assert artifact["validation_packet"]["decision"] == "FAIL"
    assert artifact["promotion_tier"] == "shadow"
    assert artifact["promotion_state"] == "shadow"
    assert artifact["primary_expected_return_allowed"] is False
    assert any(gate.startswith("residual_adjustment:") for gate in artifact["promotion_blockers"])
    assert not any(gate.startswith("execution:") for gate in artifact["promotion_blockers"])
    assert artifact["validation_packet"]["shadow_diagnostics"]["promotion_effect"] is False


def test_load_allocator_ev_fusion_training_rows_queries_verified_allocation_evidence():
    observed = []

    def query_fn(sql: str, params: list[object]) -> list[dict]:
        observed.append({"sql": sql, "params": params})
        return []

    rows = load_allocator_ev_fusion_training_rows(query_fn, end_date="2026-07-07", lookback_days=45, limit=123)

    assert rows == []
    assert len(observed) == 1
    assert "allocator_ev_feature_snapshots fs" in observed[0]["sql"]
    assert "s12_replay_trade_outcomes" in observed[0]["sql"]
    assert "AS s12_replay_pnl_pct" in observed[0]["sql"]
    assert "fs.snapshot_source = ?" in observed[0]["sql"]
    assert "fs.as_of_guard = ?" in observed[0]["sql"]
    assert "replay_diagnostics.outcome_known_date" in observed[0]["sql"]
    assert "AS l4_executable_return_pct" in observed[0]["sql"]
    assert "price_horizon_labels_v1" in observed[0]["sql"]
    assert "projection_version = 'price_horizon_v3_canonical_reference_identity'" in observed[0]["sql"]
    assert "LEAD(" not in observed[0]["sql"]
    assert "ph.exit_raw_close * ph.exit_adjustment_factor" in observed[0]["sql"]
    assert "ph.entry_raw_open * ph.entry_adjustment_factor" in observed[0]["sql"]
    assert "ph.exit_raw_close / ph.entry_raw_open" not in observed[0]["sql"]
    assert "ABS((ph.exit_adjustment_factor / ph.entry_adjustment_factor)" not in observed[0]["sql"]
    assert "sp.adj_close / sp.close" not in observed[0]["sql"]
    assert "p.verified_at IS NOT NULL" not in observed[0]["sql"]
    assert observed[0]["params"] == [
        "2026-07-07",
        "2026-07-07",
        "2026-07-07",
        "2026-07-07",
        SNAPSHOT_BACKFILL_SOURCE,
        SNAPSHOT_BACKFILL_AS_OF_GUARD,
        "2026-07-07",
        "2026-07-07",
        "-45 days",
        123,
    ]


def test_snapshot_candidate_query_avoids_correlated_evidence_lookups():
    captured = {}

    def query_fn(sql: str, params: list[object]) -> list[dict]:
        captured["sql"] = sql
        captured["params"] = params
        return []

    load_allocator_ev_snapshot_candidate_rows(
        query_fn,
        snapshot_date="2026-06-18",
        limit=200,
    )

    assert "json_group_object" not in captured["sql"]
    assert "SELECT MIN(date(sp.date))" not in captured["sql"]
    assert "date(p.prediction_date)" not in captured["sql"]
    assert "date(dr.date)" not in captured["sql"]
    assert "eligible_prediction_ids" in captured["sql"]
    assert "datetime(p.generated_at, '+8 hours')" in captured["sql"]
    assert "datetime(next_session.session_date || ' 01:00:00')" in captured["sql"]
    assert "ROW_NUMBER() OVER" in captured["sql"]
    assert "selection_reference_snapshots_v1" in captured["sql"]
    assert "canonical_run_heads" in captured["sql"]
    assert "reference_feature_rejection_reason" in captured["sql"]
    assert "r.score_components score_components" in captured["sql"]
    assert "WHERE r.score_components IS NOT NULL" in captured["sql"]
    assert "COALESCE(dr.score_components, r.score_components)" not in captured["sql"]
    assert "r.feature_available" in captured["sql"]
    assert "FROM daily_recommendations dr" in captured["sql"]
    assert "JOIN canonical_reference r" in captured["sql"]
    assert "FROM canonical_reference r" not in captured["sql"]
    assert "json_extract(r.score_components, '$.version')='score_v2'" in captured["sql"]
    assert captured["params"] == [
        "2026-06-18",
        None,
        "2026-06-18",
        "2026-06-19",
        "2026-06-18",
        "2026-06-19",
        200,
    ]


def test_snapshot_builder_rejects_missing_target_semantic_lineage():
    forecast = json.loads(_ensemble_forecast())
    forecast["ensemble_v2"].pop("target_semantic_version")
    candidate = {
        "stock_id": 1,
        "symbol": "2330",
        "recommendation_date": "2026-07-23",
        "prediction_generated_at": "2026-07-23T12:00:00Z",
        "forecast_data": json.dumps(forecast),
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "alpha_context": "{}",
        "existing_alpha_allocation": "{}",
        "current_price": 100,
    }

    def query_fn(sql: str, _params: list[object] | None = None) -> list[dict]:
        if "canonical_reference_snapshot_candidates_v4" in sql:
            return [candidate]
        if "FROM model_champion_history" in sql:
            return _champion_history_rows()
        return []

    result = build_allocator_ev_feature_snapshots_for_date(
        snapshot_date="2026-07-23",
        query_fn=query_fn,
        dry_run=True,
    )

    assert result["snapshots_built"] == 0
    assert result["rejected_lineage_rows"] == 1
    assert result["skip_reasons"] == {"lineage:target_semantic_version_missing": 1}


def test_snapshot_builder_accepts_target_semantic_from_model_score_lineage():
    forecast = json.loads(_ensemble_forecast())
    forecast["ensemble_v2"].pop("target_semantic_version")
    forecast["model_score_lineage"] = {
        "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
    }
    candidate = {
        "stock_id": 1,
        "symbol": "2330",
        "recommendation_date": "2026-07-23",
        "prediction_generated_at": "2026-07-23T12:00:00Z",
        "forecast_data": json.dumps(forecast),
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "alpha_context": "{}",
        "existing_alpha_allocation": "{}",
        "current_price": 100,
    }

    def query_fn(sql: str, _params: list[object] | None = None) -> list[dict]:
        if "canonical_reference_snapshot_candidates_v4" in sql:
            return [candidate]
        if "FROM model_champion_history" in sql:
            return _champion_history_rows()
        return []

    result = build_allocator_ev_feature_snapshots_for_date(
        snapshot_date="2026-07-23",
        query_fn=query_fn,
        dry_run=True,
    )

    assert result["snapshots_built"] == 1
    assert result["rejected_lineage_rows"] == 0
    assert result["skip_reasons"] == {}


def test_snapshot_candidate_query_accepts_calendar_next_session_without_future_close_row():
    captured = {}

    def query_fn(sql: str, params: list[object]) -> list[dict]:
        captured["sql"] = sql
        captured["params"] = params
        return []

    load_allocator_ev_snapshot_candidate_rows(
        query_fn,
        snapshot_date="2026-07-14",
        next_session_date="2026-07-15",
        limit=200,
    )

    assert "COALESCE" in captured["sql"]
    assert captured["params"][:2] == ["2026-07-14", "2026-07-15"]


def test_20260714_prediction_timestamp_is_before_20260715_market_open():
    base = {
        "prediction_date": "2026-07-14",
        "next_session_open_at": "2026-07-15T01:00:00Z",
    }
    assert prediction_timing_blockers({
        **base,
        "prediction_generated_at": "2026-07-14 17:08:52",
    }) == []
    assert prediction_timing_blockers({
        **base,
        "prediction_generated_at": "2026-07-15 01:08:52",
    }) == ["prediction_generated_at_not_before_next_session_open"]




def test_allocator_fusion_rejects_unproven_adjustment_factor_lineage():
    row = _row("2026-07-01", 1)
    row.pop("label_adjustment_source")

    samples, audit = _samples([row], min_cross_section_samples_per_date=1)

    assert samples == []
    assert audit["adjustment_lineage_counts"] == {"missing": 1}


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
        "allocator_ev_feature_snapshot_source": SNAPSHOT_BACKFILL_SOURCE,
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

    assert rows == [snapshot_row]


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


def test_allocator_ev_fusion_feature_vector_accepts_backfill_only_l4_under_canonical_guard():
    l4_payload = {
        **_l4_payload(0.02),
        "promotion_state": "snapshot_backfill_only",
        "validation_packet": {"decision": "FAIL", "failed_gates": ["walk_forward_not_stable"]},
            "snapshot_backfill_only": True,
            "snapshot_backfill_fit_eligible": True,
            "snapshot_backfill_usage_scope": SNAPSHOT_BACKFILL_USAGE_SCOPE,
            "fitted": True,
            "fit_blockers": [],
            "trained_until": "2026-07-06",
            "point_in_time_prediction_lineage": {
                "schema_version": "l4-point-in-time-prediction-lineage-v1",
                "prediction_date": "2026-07-07",
                "trained_until": "2026-07-06",
            },
    }
    row = {
        "symbol": "2330",
        "prediction_date": "2026-07-07",
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 13,
            },
        }),
        "forecast_data": _ensemble_forecast(),
        "actual_return_pct": 0.01,
        "alpha_allocation": json.dumps({
            "l4_alpha_ev": l4_payload,
            "s12_trade_ev": _s12_payload(0.01),
        }),
        "allocator_ev_feature_snapshot_source": SNAPSHOT_BACKFILL_SOURCE,
        "allocator_ev_feature_snapshot_guard": SNAPSHOT_BACKFILL_AS_OF_GUARD,
        "snapshot_lineage_cohort_id": "native:2026-07-07",
        "snapshot_generation_mode": "native",
        "snapshot_model_set_signature": "LightGBM@vTest|XGBoost@vTest",
        "snapshot_target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
    }

    features = _feature_vector(row)
    assert features is not None
    assert features["l4_expected_return"] == 0.02

    without_guard = {**row, "allocator_ev_feature_snapshot_guard": ""}
    without_guard_features = _feature_vector(without_guard)
    assert without_guard_features is not None
    assert without_guard_features["l4_expected_return"] == 0.0
    assert without_guard_features["l4_available"] == 0.0

    future_l4 = {**l4_payload, "trained_until": "2026-07-07"}
    future_row = {
        **row,
        "alpha_allocation": json.dumps({
            "l4_alpha_ev": future_l4,
            "s12_trade_ev": _s12_payload(0.01),
        }),
    }
    future_features = _feature_vector(future_row)
    assert future_features is not None
    assert future_features["l4_available"] == 0.0


def test_allocator_ev_feature_snapshot_backfill_uses_fitted_fail_artifact_only_for_training():
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
            if day_idx >= 24:
                target = -target
            l4_training_rows.append({
                "stock_id": symbol_idx,
                "symbol": f"{symbol_idx:04d}",
                "prediction_date": day,
                "prediction_generated_at": f"{day}T12:00:00Z",
                "label_adjustment_source": "stock_prices:finlab_primary_canonical_mirror",
                "forecast_data": _ensemble_forecast(
                    0.25 + (symbol_idx % 10) * 0.04,
                    0.55 + (symbol_idx % 8) * 0.03,
                ),
                "actual_return_pct": target + 0.25,
                "l4_executable_return_pct": target,
                "score": score,
                "score_components": json.dumps({
                    "version": "score_v2",
                    "semanticVersion": "score-v2-active8-components-v3",
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
        "prediction_generated_at": "2026-07-07T12:00:00Z",
        "forecast_data": _ensemble_forecast(0.35, 0.72),
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
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
        if "FROM predictions p" in sql and "JOIN daily_recommendations dr" in sql and "canonical_reference_snapshot_candidates_v4" not in sql:
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
        if "FROM model_champion_history" in sql:
            return _champion_history_rows()
        if "FROM allocator_ev_feature_snapshot_staging" in sql:
            return [{"row_count": 1}]
        if "canonical_reference_snapshot_candidates_v4" in sql:
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
    assert result["l4"]["decision"] == "FAIL"
    assert result["l4_usage_mode"] == "snapshot_backfill_only"
    assert result["snapshots_built"] == 1
    assert result["written"] == 0


def test_allocator_ev_feature_snapshot_backfill_reuses_l4_but_removes_candidate_time_s12():
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
        "prediction_generated_at": "2026-07-07T12:00:00Z",
        "forecast_data": _ensemble_forecast(0.35, 0.72),
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
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
        if "FROM predictions p" in sql and "JOIN daily_recommendations dr" in sql and "canonical_reference_snapshot_candidates_v4" not in sql:
            assert params[0] == "2026-07-06"
            return []
        if "FROM s12_replay_trade_outcomes" in sql:
            return []
        if "FROM s12_structure_snapshots" in sql:
            return []
        if "FROM model_champion_history" in sql:
            return _champion_history_rows()
        if "canonical_reference_snapshot_candidates_v4" in sql:
            return [candidate]
        if "FROM allocator_ev_feature_snapshot_staging" in sql:
            return [{"row_count": 1}]
        if "SELECT status, published_rows FROM allocator_ev_snapshot_runs" in sql:
            return [{"status": "ready", "published_rows": 1}]
        return []

    result = build_allocator_ev_feature_snapshots_for_date(
        snapshot_date="2026-07-07",
        query_fn=query_fn,
        dry_run=True,
        l4_min_samples=200,
        l4_min_dates=20,
    )

    assert result["snapshots_built"] == 1
    assert result["l4_usage_mode"] == "not_fit_eligible"
    assert result["reused_l4_payloads"] == 1
    assert result["candidate_time_s12_feature_count"] == 0
    assert result["skip_reasons"] == {}


def test_allocator_ev_feature_snapshot_backfill_keeps_raw_features_when_l4_cannot_fit():
    candidate = {
        "stock_id": 1,
        "symbol": "2330",
        "recommendation_date": "2026-06-08",
        "prediction_generated_at": "2026-06-08T12:00:00Z",
        "forecast_data": _ensemble_forecast(0.35, 0.72),
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "alpha_context": json.dumps({"market_heat_expected_return": 0.003}),
        "existing_alpha_allocation": json.dumps({
            "l4_alpha_ev": {"status": "rejected", "trained_until": "2026-06-08"},
        }),
        "current_price": 100,
    }
    written: list[tuple[str, list[object]]] = []

    def query_fn(sql: str, params: list[object] | None = None) -> list[dict]:
        if "FROM predictions p" in sql and "JOIN daily_recommendations dr" in sql and "canonical_reference_snapshot_candidates_v4" not in sql:
            return []
        if "FROM s12_replay_trade_outcomes" in sql:
            return []
        if "FROM s12_structure_snapshots" in sql:
            return []
        if "FROM model_champion_history" in sql:
            return _champion_history_rows()
        if "canonical_reference_snapshot_candidates_v4" in sql:
            return [candidate]
        if "FROM allocator_ev_feature_snapshot_staging" in sql:
            return [{"row_count": 1}]
        if "SELECT status, published_rows FROM allocator_ev_snapshot_runs" in sql:
            return [{"status": "ready", "published_rows": 1}]
        return []

    result = build_allocator_ev_feature_snapshots_for_date(
        snapshot_date="2026-06-08",
        query_fn=query_fn,
        write_fn=lambda statements: written.extend(statements) or {"changes_total": len(statements)},
        dry_run=False,
        l4_min_samples=500,
        l4_min_dates=20,
        lineage_cohort_id="pipeline-v2-test",
    )

    assert result["status"] == "ok"
    assert result["l4_usage_mode"] == "not_fit_eligible"
    assert result["snapshots_built"] == 1
    assert result["snapshots_without_l4"] == 1
    allocation = json.loads(written[1][1][8])
    assert "l4_alpha_ev" not in allocation
    assert allocation["snapshot_l4_available"] is False
    assert "allocator_ev_feature_snapshot_staging" in written[1][0]
    assert "lineage_cohort_id" in written[1][0]
    assert written[1][1][18:22] == [
        "pipeline-v2-test",
        "native",
        "LightGBM@vTest|XGBoost@vTest",
        MODEL_TARGET_SEMANTIC_VERSION,
    ]
    assert "INSERT INTO allocator_ev_feature_snapshots" in written[2][0]
    assert "lineage_cohort_id" in written[2][0]
    assert "ON CONFLICT(snapshot_date, stock_id, snapshot_source) DO UPDATE" in written[2][0]
    assert "INSERT OR REPLACE" not in written[2][0]
    assert "ORDER BY datetime(latest.created_at) DESC, latest.run_id DESC" in written[2][0]
    assert "DELETE FROM allocator_ev_feature_snapshots" in written[3][0]


def test_allocator_ev_feature_snapshot_backfill_does_not_cleanup_after_partial_write():
    candidate = {
        "stock_id": 1,
        "symbol": "2330",
        "recommendation_date": "2026-07-07",
        "prediction_generated_at": "2026-07-07T12:00:00Z",
        "forecast_data": _ensemble_forecast(0.35, 0.72),
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "alpha_context": json.dumps({"market_heat_expected_return": 0.003}),
        "existing_alpha_allocation": json.dumps({}),
        "current_price": 100,
    }
    calls: list[list[tuple[str, list[object]]]] = []

    def query_fn(sql: str, _params: list[object] | None = None) -> list[dict]:
        if "FROM model_champion_history" in sql:
            return _champion_history_rows()
        if "canonical_reference_snapshot_candidates_v4" in sql:
            return [candidate]
        return []

    def partial_writer(statements: list[tuple[str, list[object]]]) -> dict:
        calls.append(statements)
        return {"success_count": 0, "error_count": 1, "changes_total": 0, "first_error": "test"}

    with pytest.raises(RuntimeError, match="allocator_snapshot_staging_partial_failure"):
        build_allocator_ev_feature_snapshots_for_date(
            snapshot_date="2026-07-07",
            query_fn=query_fn,
            write_fn=partial_writer,
            dry_run=False,
        )

    assert len(calls) == 2
    assert "INSERT INTO allocator_ev_snapshot_runs" in calls[0][0][0]
    assert "allocator_ev_feature_snapshot_staging" in calls[0][1][0]
    assert "status='failed'" in calls[1][0][0]


def test_allocator_ev_feature_snapshot_backfill_rejects_partial_candidate_cohort_before_staging():
    valid_candidate = {
        "stock_id": 1,
        "symbol": "2330",
        "recommendation_date": "2026-07-07",
        "prediction_generated_at": "2026-07-07T12:00:00Z",
        "forecast_data": _ensemble_forecast(0.35, 0.72),
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "alpha_context": "{}",
        "existing_alpha_allocation": "{}",
        "current_price": 100,
        "candidate_total_count": 2,
    }
    invalid_forecast = json.loads(_ensemble_forecast(0.35, 0.72))
    invalid_forecast["ensemble_v2"].pop("target_semantic_version")
    invalid_candidate = {
        **valid_candidate,
        "stock_id": 2,
        "symbol": "2317",
        "forecast_data": json.dumps(invalid_forecast),
    }
    calls: list[list[tuple[str, list[object]]]] = []

    def query_fn(sql: str, _params: list[object] | None = None) -> list[dict]:
        if "FROM model_champion_history" in sql:
            return _champion_history_rows()
        if "canonical_reference_snapshot_candidates_v4" in sql:
            return [valid_candidate, invalid_candidate]
        return []

    def writer(statements: list[tuple[str, list[object]]]) -> dict:
        calls.append(statements)
        return {
            "success_count": len(statements),
            "error_count": 0,
            "changes_total": len(statements),
        }

    with pytest.raises(
        RuntimeError,
        match=r"allocator_snapshot_candidate_closure_mismatch:.*expected=2:accepted=1:rejected=1",
    ):
        build_allocator_ev_feature_snapshots_for_date(
            snapshot_date="2026-07-07",
            query_fn=query_fn,
            write_fn=writer,
            dry_run=False,
            lineage_cohort_id="pipeline-v2-partial",
        )

    assert len(calls) == 1
    assert len(calls[0]) == 2
    assert "INSERT INTO allocator_ev_snapshot_runs" in calls[0][0][0]
    assert calls[0][0][1][4] == 2
    assert "status='failed'" in calls[0][1][0]
    assert all(
        "allocator_ev_feature_snapshot_staging" not in sql
        and "allocator_ev_feature_snapshots" not in sql
        for sql, _params in calls[0]
    )


def test_allocator_ev_feature_snapshot_backfill_recomputes_opaque_s12_payload():
    existing = {
        "snapshot_source": SNAPSHOT_BACKFILL_SOURCE,
        "s12_trade_ev": _s12_payload(0.009),
    }
    candidate = {
        "stock_id": 1,
        "symbol": "2330",
        "recommendation_date": "2026-07-02",
        "prediction_generated_at": "2026-07-02T12:00:00Z",
        "forecast_data": json.dumps({"ensemble_v2": {"avg_rank": 0.35, "confidence": 0.72}}),
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
        }),
        "alpha_context": json.dumps({"market_heat_expected_return": 0.003}),
        "existing_alpha_allocation": json.dumps(existing),
        "current_price": 100,
    }

    def query_fn(sql: str, _params: list[object] | None = None) -> list[dict]:
        if "canonical_reference_snapshot_candidates_v4" in sql:
            return [candidate]
        return []

    result = build_allocator_ev_feature_snapshots_for_date(
        snapshot_date="2026-07-02",
        query_fn=query_fn,
        dry_run=True,
    )

    assert result["candidate_time_s12_feature_count"] == 0


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
                "label_adjustment_source": "stock_prices:finlab_primary_canonical_mirror",
                "score_components": json.dumps({
                    "version": "score_v2",
                    "semanticVersion": "score-v2-active8-components-v3",
                    "finalScore": 60,
                    "components": {
                        "mlEdge": 15,
                        "fundamentalQuality": 15,
                        "chipFlow": 15,
                        "technicalStructure": 15,
                    },
                }),
                "forecast_data": _ensemble_forecast(),
                "actual_return_pct": 0.25,
                "l4_executable_return_pct": l4 + (0.004 if has_s12 else -0.003),
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
    assert audit["candidate_time_s12_feature_count"] == 0


def test_allocator_ev_fusion_keeps_raw_selection_sample_when_l4_and_s12_are_missing():
    row = {
        "symbol": "2330",
        "prediction_date": "2026-07-02",
        "label_adjustment_source": "stock_prices:finlab_primary_canonical_mirror",
        "actual_return_pct": -0.30,
        "l4_executable_return_pct": 0.02,
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "forecast_data": _ensemble_forecast(0.65, 0.72),
        "alpha_allocation": json.dumps({}),
    }

    samples, audit = _samples([row], min_cross_section_samples_per_date=1)

    assert audit["sample_count"] == 1
    assert samples[0]["features"]["l4_available"] == 0.0
    assert all(not name.startswith("s12_") for name in samples[0]["features"])
    assert audit["candidate_time_s12_feature_count"] == 0
    assert samples[0]["features"]["score_v2_available"] == 1.0
    assert samples[0]["execution_target"] is None


def test_allocator_ev_fusion_rejects_legacy_unversioned_score_feature_era():
    row = {
        "symbol": "2330",
        "prediction_date": "2026-05-04",
        "actual_return_pct": -0.30,
        "l4_executable_return_pct": 0.02,
        "score_components": json.dumps({
            "chip": 33,
            "tech": 16,
            "ml": 13.5,
            "rawScore": 62.5,
        }),
        "alpha_allocation": json.dumps({}),
    }

    samples, audit = _samples([row])

    assert samples == []
    assert audit["sample_count"] == 0
    assert audit["rejected_feature_era_rows"] == 1
    assert audit["feature_era_counts"] == {"legacy_unversioned": 1}
    assert audit["feature_era_policy"]["legacy_direct_training_allowed"] is False


def test_allocator_ev_fusion_rejects_sparse_cross_section_dates():
    rows = [_row("2026-06-08", idx) for idx in range(19)]

    samples, audit = _samples(rows)

    assert samples == []
    assert audit["date_count"] == 0
    assert audit["sparse_dates_rejected"] == ["2026-06-08"]
    assert audit["sparse_date_rows_rejected"] == 19
    assert audit["min_cross_section_samples_per_date"] == 20


def test_execution_replay_label_is_kept_when_prior_s12_ev_was_unavailable():
    row = {
        "symbol": "2330",
        "prediction_date": "2026-07-02",
        "label_adjustment_source": "stock_prices:finlab_primary_canonical_mirror",
        "actual_return_pct": -0.30,
        "l4_executable_return_pct": 0.02,
        "s12_replay_pnl_pct": 0.015,
        "s12_replay_status": "executed",
        "score": 70,
        "score_components": json.dumps({
            "version": "score_v2",
            "semanticVersion": "score-v2-active8-components-v3",
            "finalScore": 70,
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
            },
        }),
        "forecast_data": _ensemble_forecast(0.65, 0.72),
        "alpha_allocation": json.dumps({}),
    }

    samples, audit = _samples([row], execution_cost_bps=18.0, min_cross_section_samples_per_date=1)

    assert audit["candidate_time_s12_feature_count"] == 0
    assert audit["execution_sample_count"] == 1
    assert all(not name.startswith("s12_") for name in samples[0]["features"])
    assert samples[0]["execution_target"] == pytest.approx(0.0132)
    assert samples[0]["realized_trade_ev_target"] == pytest.approx(0.0132)
    assert samples[0]["execution_probability_target"] == 1.0


def test_allocator_ev_fusion_uses_executable_selection_label_not_prediction_actual_return():
    row = _row("2026-06-01", 1)
    row["actual_return_pct"] = -0.30
    row["l4_executable_return_pct"] = 0.03
    row["trade_pnl_pct"] = -0.20
    row["s12_replay_pnl_pct"] = None
    row["s12_replay_status"] = "not_triggered"

    samples, audit = _samples([row], min_cross_section_samples_per_date=1)

    assert samples[0]["actual_return_target"] == pytest.approx(0.03)
    assert samples[0]["selection_target"] == pytest.approx(0.0)
    assert samples[0]["selection_rank_target"] == pytest.approx(0.0)
    assert samples[0]["execution_target"] is None
    assert samples[0]["realized_trade_ev_target"] == pytest.approx(0.0)
    assert samples[0]["actual_trade_target_audit_only"] == pytest.approx(-0.20)
    assert audit["target_policy"]["actual_trade_outcome_role"] == "audit_only_not_training_label"



def test_allocator_ev_fusion_does_not_label_unavailable_replay_as_non_execution():
    row = _row("2026-06-01", 1)
    row["l4_executable_return_pct"] = 0.03
    row["s12_replay_pnl_pct"] = None
    row["s12_replay_status"] = "skipped"
    row["s12_replay_archetype"] = "missing_intraday_bars"

    samples, audit = _samples([row], min_cross_section_samples_per_date=1)

    assert samples[0]["execution_observation_kind"] == "unavailable"
    assert samples[0]["execution_probability_target"] is None
    assert samples[0]["realized_trade_ev_target"] is None
    assert samples[0]["execution_label_source"] is None
    assert audit["execution_observation_count"] == 0
    assert audit["execution_observation_kind_counts"] == {"unavailable": 1}
    assert "unavailable_excluded" in audit["target_policy"]["full_trade_ev"]

def test_allocator_ev_fusion_prefers_canonical_s12_replay_outcome_label():
    row = _row("2026-06-01", 1)
    row["actual_return_pct"] = -0.30
    row["l4_executable_return_pct"] = 0.03
    row["trade_pnl_pct"] = -0.20
    row["s12_replay_pnl_pct"] = 0.08
    row["s12_replay_status"] = "executed"

    samples, audit = _samples([row], min_cross_section_samples_per_date=1)

    assert samples[0]["trade_target"] == pytest.approx(0.08)
    assert samples[0]["execution_target"] == pytest.approx(0.08)
    assert samples[0]["execution_label_source"] == "s12_replay_trade_outcomes"
    assert audit["execution_label_source_counts"] == {"s12_replay_trade_outcomes": 1}



def test_allocator_ev_fusion_missing_unused_market_context_is_diagnostic_only():
    rows = []
    for day_idx in range(32):
        day = (date(2026, 4, 1) + timedelta(days=day_idx)).isoformat()
        for symbol_idx in range(64):
            row = _row(day, symbol_idx)
            alpha_context = json.loads(row["alpha_context"])
            alpha_context.pop("market_regime_context", None)
            row["alpha_context"] = json.dumps(alpha_context)
            rows.append(row)

    out = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until="2026-05-31",
        knowledge_cutoff_date="2026-05-31",
        min_dates=20,
        min_samples=1000,
        l2=0.15,
    )

    artifact = out["artifact"]
    assert artifact["promotion_tier"] == "shadow"
    assert artifact["primary_expected_return_allowed"] is False
    assert "primary_market_context_samples_low" not in artifact["promotion_blockers"]
    assert "primary_market_context_dates_low" not in artifact["promotion_blockers"]
    assert artifact["validation_packet"]["promotion"]["primary_requirements"]["optional_context_features_gate_only_when_supported_by_training_window"] is True
    assert artifact["validation_packet"]["sample_audit"]["market_context_available_coverage"] == 0.0
