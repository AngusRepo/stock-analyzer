from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.l4_alpha_ev_artifact_builder import (  # noqa: E402
    _date_cluster_metrics,
    _samples,
    build_l4_alpha_ev_artifact_from_rows,
    load_l4_alpha_ev_training_rows,
)


def _row(day: str, idx: int, *, target: float) -> dict:
    score = 55.0 + (idx % 40)
    ml_edge = 8.0 + (idx % 15)
    fundamental = 6.0 + (idx % 18)
    chip = 7.0 + (idx % 16)
    technical = 9.0 + (idx % 14)
    avg_rank = 0.35 + (score / 100.0) * 0.5
    confidence = 0.45 + (ml_edge / 25.0) * 0.35
    return {
        "symbol": f"{idx:04d}",
        "prediction_date": day,
        "label_adjustment_source": "stock_prices:finlab_primary_canonical_mirror",
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
                "newsTheme": 0.0,
            },
        }),
        "forecast_data": json.dumps({
            "ensemble_v2": {
                "semantic_version": "active8-ic-weighted-rank-v4",
                "contributing_models": ["LightGBM", "XGBoost"],
                "artifact_versions": {"LightGBM": "vTest", "XGBoost": "vTest"},
                "model_set_signature": "LightGBM@vTest|XGBoost@vTest",
                "avg_rank": avg_rank,
                "confidence": confidence,
            },
        }),
    }


def test_l4_purged_oof_accepts_only_recorded_canonical_market_lineage():
    rows = []
    for idx in range(20):
        row = _row("2026-05-01", idx, target=0.01 + idx * 0.0001)
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
    assert audit["invalid_reason_counts"] == {}

    rows[0]["label_adjustment_source"] = "stock_prices:finlab_primary_canonical_mirror"
    samples, audit = _samples(rows, min_cross_section_samples_per_date=1)
    assert len(samples) == 19
    assert audit["invalid_reason_counts"] == {"adjustment_source_mismatch:purged_oof": 1}


def test_l4_date_cluster_metrics_equal_weight_trading_dates():
    samples = []
    pairs = []
    for day, top_return in (("2026-06-01", 0.03), ("2026-06-02", -0.02), ("2026-06-03", -0.02)):
        for idx in range(10):
            prediction = float(idx)
            target = top_return if idx >= 8 else (-0.01 + idx * 0.001)
            samples.append({"date": day})
            pairs.append((prediction, target))

    metrics = _date_cluster_metrics(samples, pairs)

    assert metrics["date_count"] == 3
    assert metrics["date_mean_top_quintile_return"] < 0.0
    assert metrics["date_mean_top_quintile_return_lcb90"] < 0.0


def test_l4_alpha_ev_artifact_builder_emits_production_artifact_when_oos_passes():
    rows = []
    for day_idx in range(30):
        day = f"2026-05-{day_idx + 1:02d}"
        for symbol_idx in range(25):
            strength = symbol_idx / 25.0
            target = -0.01 + 0.03 * strength + 0.0001 * day_idx
            rows.append(_row(day, symbol_idx, target=target))

    out = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until="2026-06-30",
        min_samples=200,
        min_dates=20,
        l2=0.25,
    )

    artifact = out["artifact"]
    assert out["status"] == "ok"
    assert artifact["promotion_state"] == "production_approved"
    assert artifact["validation_packet"]["decision"] == "PASS"
    assert artifact["resolver_method"] == "ridge_meta_calibrator"
    assert artifact["expected_return_owner"] == "l4_alpha_ev"
    assert artifact["output_is_net_of_costs"] is True
    assert artifact["artifact_contract_version"] == "l4-alpha-ev-contract-v4"
    assert artifact["label_schema_version"] == "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
    assert artifact["feature_semantic_version"] == "l4-directional-score-components-v2-lineage-bound"
    assert "expectedReturnCalibration" not in artifact
    assert artifact["coefficients"]["ensemble_directional_margin"] != 0
    assert "ensemble_confidence_centered" not in artifact["coefficients"]


def test_l4_alpha_ev_artifact_builder_fails_closed_on_insufficient_samples():
    rows = [_row("2026-05-01", idx, target=0.01) for idx in range(10)]

    out = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until="2026-06-30",
        min_samples=200,
        min_dates=20,
    )

    artifact = out["artifact"]
    assert out["status"] == "failed_validation"
    assert artifact["promotion_state"] == "approval_required"
    assert artifact["validation_packet"]["decision"] == "FAIL"
    assert "insufficient_samples" in artifact["validation_packet"]["failed_gates"]


def test_l4_alpha_ev_artifact_builder_uses_snapshot_date_for_oof_rows():
    rows = []
    for day_idx in range(5):
        day = f"2026-06-{day_idx + 1:02d}"
        for symbol_idx in range(20):
            row = _row(day, symbol_idx, target=0.001 * symbol_idx)
            row["snapshot_date"] = row.pop("prediction_date")
            rows.append(row)

    out = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until="2026-06-30",
        min_samples=200,
        min_dates=20,
        fit_min_samples=50,
        fit_min_dates=3,
    )

    audit = out["artifact"]["validation_packet"]["sample_audit"]
    assert audit["sample_count"] == 100
    assert audit["date_count"] == 5


def test_l4_alpha_ev_artifact_builder_reports_oof_semantic_by_generation_mode():
    rows = []
    for day_idx in range(5):
        day = f"2026-06-{day_idx + 1:02d}"
        for symbol_idx in range(20):
            row = _row(day, symbol_idx, target=0.001 * symbol_idx)
            forecast = json.loads(row["forecast_data"])
            row["generation_mode"] = "purged_oof"
            row["label_adjustment_source"] = "canonical_market_daily:finlab.price"
            forecast["ensemble_v2"]["generation_mode"] = "purged_oof"
            forecast["ensemble_v2"]["semantic_version"] = (
                "active8-purged-oof-chronological-ridge-v3"
            )
            row["forecast_data"] = json.dumps(forecast)
            rows.append(row)

    out = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until="2026-06-30",
        min_samples=200,
        min_dates=20,
        fit_min_samples=50,
        fit_min_dates=3,
    )

    audit = out["artifact"]["validation_packet"]["sample_audit"]
    assert audit["ensemble_generation_mode_counts"] == {"purged_oof": 100}
    assert audit["required_ensemble_semantic_version"] == (
        "active8-purged-oof-chronological-ridge-v3"
    )
    assert audit["lineage_blocker_counts"] == {}
    assert audit["feature_profile"]["fundamental_quality_norm"]["nonzero_samples"] == 100
    assert audit["feature_profile"]["fundamental_quality_norm"]["degenerate"] is False


def test_l4_alpha_ev_artifact_builder_reports_degenerate_feature_without_forcing_gate():
    rows = []
    for day_idx in range(10):
        day = f"2026-06-{day_idx + 1:02d}"
        for symbol_idx in range(20):
            row = _row(day, symbol_idx, target=0.001 * symbol_idx)
            score = json.loads(row["score_components"])
            score["components"]["fundamentalQuality"] = 0.0
            row["score_components"] = json.dumps(score)
            rows.append(row)

    out = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until="2026-06-30",
        min_samples=500,
        min_dates=20,
        fit_min_samples=50,
        fit_min_dates=3,
    )

    packet = out["artifact"]["validation_packet"]
    audit = packet["sample_audit"]
    assert audit["degenerate_features"] == ["fundamental_quality_norm"]
    assert audit["feature_profile"]["fundamental_quality_norm"] == {
        "samples": 200,
        "nonzero_samples": 0,
        "minimum": 0.0,
        "maximum": 0.0,
        "mean": 0.0,
        "standard_deviation": 0.0,
        "degenerate": True,
    }
    assert "degenerate_features" not in packet["failed_gates"]


def test_l4_alpha_ev_artifact_builder_can_fit_strict_asof_oof_without_promotion():
    rows = []
    for day_idx in range(12):
        day = f"2026-06-{day_idx + 1:02d}"
        for symbol_idx in range(24):
            strength = symbol_idx / 24.0
            rows.append(_row(day, symbol_idx, target=-0.01 + 0.025 * strength))

    out = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until="2026-06-12",
        min_samples=500,
        min_dates=20,
        fit_min_samples=100,
        fit_min_dates=5,
    )

    artifact = out["artifact"]
    assert out["status"] == "failed_validation"
    assert artifact["fitted"] is True
    assert artifact["promotion_state"] == "approval_required"
    assert "insufficient_dates" in artifact["validation_packet"]["failed_gates"]
    assert artifact["coefficients"]["ensemble_directional_margin"] != 0


def test_l4_training_query_uses_outcome_knowledge_cutoff_after_signal_end_date():
    captured = {}

    def fake_query(sql, params):
        captured["sql"] = sql
        captured["params"] = params
        return []

    load_l4_alpha_ev_training_rows(
        fake_query,
        end_date="2026-07-02",
        knowledge_cutoff_date="2026-07-09",
        lookback_days=90,
        limit=6000,
    )

    assert captured["params"] == [
        "2026-07-02",
        "-90 days",
        "2026-07-02",
        "2026-07-09",
        6000,
    ]
    assert "price_horizon_labels_v1" in captured["sql"]
    assert "projection_version = 'price_horizon_v1'" in captured["sql"]
    assert "LEAD(" not in captured["sql"]
    assert "ph.exit_raw_close * ph.exit_adjustment_factor" in captured["sql"]
    assert "ph.entry_raw_open * ph.entry_adjustment_factor" in captured["sql"]
    assert "ph.exit_raw_close / ph.entry_raw_open" not in captured["sql"]
    assert "ABS((ph.exit_adjustment_factor / ph.entry_adjustment_factor)" not in captured["sql"]
    assert "sp.adj_close / sp.close" not in captured["sql"]
    assert "predictions p INDEXED BY idx_pred_date_model_stock" in captured["sql"]
    assert "date(sp.date)" not in captured["sql"]
    assert "date(p.prediction_date)" not in captured["sql"]
    assert "datetime(p.generated_at, '+8 hours')" in captured["sql"]
    assert "datetime(ph.entry_date || ' 01:00:00')" in captured["sql"]


def test_l4_builder_rejects_unproven_adjustment_factor_lineage():
    rows = [_row("2026-05-01", idx, target=0.01) for idx in range(25)]
    for row in rows:
        row.pop("label_adjustment_source")

    out = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until="2026-06-30",
        min_samples=20,
        min_dates=1,
    )

    audit = out["artifact"]["validation_packet"]["sample_audit"]
    assert audit["sample_count"] == 0
    assert audit["adjustment_lineage_counts"] == {"missing": 25}
