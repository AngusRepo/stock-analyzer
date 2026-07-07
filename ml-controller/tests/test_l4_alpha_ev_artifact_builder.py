from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.l4_alpha_ev_artifact_builder import build_l4_alpha_ev_artifact_from_rows  # noqa: E402


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
        "actual_return_pct": target,
        "score": score,
        "score_components": json.dumps({
            "version": "score_v2",
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
    assert artifact["output_is_net_of_costs"] is False
    assert "expectedReturnCalibration" not in artifact
    assert artifact["coefficients"]["score_final_norm"] != 0


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

