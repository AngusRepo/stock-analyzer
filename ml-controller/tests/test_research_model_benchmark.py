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


def test_research_model_benchmark_accepts_maintained_library_executor_metrics_without_controller_runtime():
    report = build_model_family_benchmark_report(
        candidate_id="PatchTST",
        experiment_id="exp-sequence-upgrade",
        start_date="2025-01-01",
        end_date="2026-04-30",
        data_slice={"universe": "twse_tpex"},
        executor_result={
            "fold_metrics": [
                {"fold_id": "w1", "oos_ic": 0.04, "test_rows": 120, "coverage": 0.8},
                {"fold_id": "w2", "oos_ic": 0.03, "test_rows": 120, "coverage": 0.8},
                {"fold_id": "w3", "oos_ic": 0.02, "test_rows": 120, "coverage": 0.8},
            ],
            "pbo": 0.0,
            "cost_sensitivity": {"status": "available", "latency_sec": 12.0, "gpu": "L4"},
            "data_slice_report": {"status": "available", "symbols": 256, "rows": 40000},
        },
    )

    assert report["candidate_id"] == "PatchTST"
    assert not any(blocker.startswith("missing_runtime_package") for blocker in report["blockers"])
    assert report["status"] == "ready_for_review"


def test_timesfm_benchmark_does_not_require_pbo_for_single_official_config():
    report = build_model_family_benchmark_report(
        candidate_id="TimesFM",
        experiment_id="exp-timesfm25-context",
        start_date="2025-01-01",
        end_date="2026-04-30",
        data_slice={"universe": "twse_tpex", "search_trials": 1},
        executor_result={
            "coverage_mode": "sample_complete",
            "fold_metrics": [
                {
                    "fold_id": f"ctx1024_{i}",
                    "oos_ic": 0.03 + i * 0.001,
                    "test_rows": 64,
                    "coverage": 1.0,
                    "dataset_coverage": 0.125,
                }
                for i in range(5)
            ],
            "cost_sensitivity": {"status": "available", "latency_sec": 18.0, "gpu": "L4"},
            "data_slice_report": {
                "status": "available",
                "available_oos_windows": 4096,
                "sampled_oos_windows": 512,
                "dataset_coverage": 0.125,
                "coverage_mode": "sample_complete",
            },
        },
    )

    assert "missing_pbo_cpcv" not in report["blockers"]
    assert report["validation_policy"]["pbo"]["required"] is False
    assert report["cpcv_evidence"]["policy"]["coverage_mode"] == "sample_complete"
    assert report["status"] == "ready_for_review"


def test_research_model_benchmark_does_not_expose_timesfm25_as_active_candidate():
    report = build_model_family_benchmark_report(
        candidate_id="TimesFM25",
        experiment_id="exp-sequence-upgrade",
        start_date="2025-01-01",
        end_date="2026-04-30",
    )

    assert report["status"] == "blocked"
    assert "unknown_benchmark_candidate" in report["blockers"]
    assert "TimesFM" in report["supported_candidates"]
    assert "TimesFM25" not in report["supported_candidates"]
