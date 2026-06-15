from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import foundation_forecast_evidence as evidence  # noqa: E402


def test_build_foundation_evidence_from_d1_uses_rank_score_fallback(monkeypatch):
    rows = [
        {
            "id": 1,
            "stock_id": 1,
            "symbol": "2330",
            "prediction_date": "2026-06-11",
            "actual_return_pct": 0.03,
            "forecast_data": '{"rank_score":0.7}',
        },
        {
            "id": 2,
            "stock_id": 2,
            "symbol": "2317",
            "prediction_date": "2026-06-11",
            "actual_return_pct": -0.02,
            "forecast_data": '{"rank_score":0.3}',
        },
        {
            "id": 3,
            "stock_id": 3,
            "symbol": "2882",
            "prediction_date": "2026-06-10",
            "actual_return_pct": 0.01,
            "forecast_data": '{"rank_score":0.6}',
        },
        {
            "id": 4,
            "stock_id": 4,
            "symbol": "1301",
            "prediction_date": "2026-06-10",
            "actual_return_pct": -0.04,
            "forecast_data": '{"rank_score":0.2}',
        },
    ]
    monkeypatch.setattr(evidence.d1_client, "query", lambda *args, **kwargs: rows)

    out = evidence.build_foundation_evidence_from_d1(
        run_date="2026-06-14",
        policy={"min_samples": 4, "min_rank_ic": 0.5, "min_direction_accuracy": 0.7},
    )

    assert out is not None
    assert out["method"] == "foundation_forecast_rank_ic"
    assert out["decision"] == "PASS"
    assert out["oos_ic_mean"] == 1.0
    assert out["samples"] == 4
    assert out["forecast_pct_sources"] == {"forecast_data.rank_score_centered": 4}


def test_attach_timesfm_foundation_evidence_to_followup_payload(monkeypatch):
    payload = {
        "run_date": "2026-06-14",
        "stages": {
            "artifact_lifecycle": {
                "results": {
                    "TimesFM": {
                        "status": "ok",
                        "version": "v20260612T160113_timesfm25_ctx1024",
                        "artifact_path": "universal/timesfm/v20260612T160113_timesfm25_ctx1024.json",
                        "artifact_type": "foundation_forecast_config",
                    },
                },
            },
        },
    }
    monkeypatch.setattr(
        evidence,
        "build_foundation_evidence_from_d1",
        lambda **kwargs: {
            "method": "foundation_forecast_rank_ic",
            "decision": "PASS",
            "oos_ic_mean": 0.123456,
            "samples": 88,
            "direction_accuracy": 0.59,
            "coverage_mean": 1.0,
            "forecast_bias": 0.0,
            "forecast_pct_sources": {"forecast_data.forecast_pct": 88},
        },
    )

    result = evidence.attach_timesfm_foundation_evidence_to_followup_payload(payload)

    timesfm = payload["stages"]["artifact_lifecycle"]["results"]["TimesFM"]
    assert result["updated"] is True
    assert timesfm["oos_ic"] == 0.123456
    assert timesfm["metrics"]["oos_samples"] == 88
    assert timesfm["model_cpcv"]["decision"] == "PASS"
    assert timesfm["last_artifact_evidence"]["method"] == "foundation_forecast_rank_ic"
