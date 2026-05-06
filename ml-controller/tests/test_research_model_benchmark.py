from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.research_model_benchmark import build_model_family_benchmark_report  # noqa: E402


def test_research_model_benchmark_fails_closed_without_executor_evidence():
    report = build_model_family_benchmark_report(
        candidate_id="TabM",
        experiment_id="exp-model-upgrade",
        start_date="2025-01-01",
        end_date="2026-04-30",
        data_slice={"universe": "twse_tpex"},
    )

    assert report["schema_version"] == "model-family-benchmark-report-v1"
    assert report["candidate_id"] == "TabM"
    assert report["status"] == "blocked"
    assert "missing_executor_result" in report["blockers"]
    assert "missing_oos_fold_metrics" in report["blockers"]
    assert "missing_pbo_cpcv" in report["blockers"]
    assert report["promotion_allowed"] is False
    assert report["production_mutation_allowed"] is False


def test_research_model_benchmark_aggregates_real_fold_metrics_without_promoting():
    report = build_model_family_benchmark_report(
        candidate_id="iTransformer",
        experiment_id="exp-model-upgrade",
        start_date="2025-01-01",
        end_date="2026-04-30",
        data_slice={"universe": "twse_tpex"},
        executor_result={
            "fold_metrics": [
                {"fold_id": "w1", "oos_ic": 0.05, "test_rows": 120, "coverage": 0.8},
                {"fold_id": "w2", "oos_ic": 0.03, "test_rows": 110, "coverage": 0.75},
                {"fold_id": "w3", "oos_ic": 0.02, "test_rows": 115, "coverage": 0.78},
            ],
            "pbo": 0.22,
            "cost_sensitivity": {
                "status": "available",
                "latency_sec": 42.0,
                "estimated_modal_usd": 0.18,
                "gpu": "L4",
            },
            "data_slice_report": {
                "status": "available",
                "symbols": 120,
                "windows": 3,
            },
        },
    )

    assert report["oos_ic_mean"] > 0
    assert report["pbo"] == 0.22
    assert report["cost_sensitivity"]["status"] == "available"
    assert report["data_slice_report"]["symbols"] == 120
    assert report["promotion_allowed"] is False
