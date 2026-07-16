from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.l4_alpha_ev_artifact_builder import (  # noqa: E402
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
        "label_adjustment_source": "canonical_market_daily:finlab.price",
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

    assert captured["params"][2] == "2026-07-09"
    assert captured["params"][3] == "2026-07-09"
    assert captured["params"][4] == "2026-07-02"
    assert "canonical_market_daily cmd" in captured["sql"]
    assert "cmd.adj_close / cmd.close" in captured["sql"]
    assert "ph.exit_raw_close * ph.exit_adjustment_factor" in captured["sql"]
    assert "ph.entry_raw_open * ph.entry_adjustment_factor" in captured["sql"]
    assert "ph.exit_raw_close / ph.entry_raw_open" not in captured["sql"]
    assert "ABS((ph.exit_adjustment_factor / ph.entry_adjustment_factor)" not in captured["sql"]
    assert "sp.adj_close / sp.close" not in captured["sql"]


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
