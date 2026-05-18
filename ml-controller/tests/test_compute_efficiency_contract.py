from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.compute_efficiency_contract import (  # noqa: E402
    COMPUTE_EFFICIENCY_SCHEMA_VERSION,
    build_compute_efficiency_report,
    build_compute_profile_pair,
    build_monthly_retrain_stage_timing_report,
    normalize_compute_profile,
    validate_compute_efficiency_report,
)


def test_accepts_optimization_only_when_high_spec_quality_is_preserved():
    report = build_compute_efficiency_report(
        job_name="monthly-universal-retrain",
        baseline={
            "wall_sec": 5400,
            "est_usd": 18.0,
            "cpu_sec": 21600,
            "gpu_sec": 1800,
            "rows": 1_200_000,
            "features": 106,
        },
        optimized={
            "wall_sec": 3300,
            "est_usd": 10.8,
            "cpu_sec": 11000,
            "gpu_sec": 1600,
            "rows": 1_200_000,
            "features": 106,
        },
        quality={
            "ic_delta": 0.002,
            "precision_at_k_delta": 0.004,
            "hit_rate_delta": 0.001,
            "max_drawdown_delta": -0.2,
            "topk_overlap": 0.84,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert report["schema_version"] == COMPUTE_EFFICIENCY_SCHEMA_VERSION
    assert report["decision"] == "ACCEPT_HIGH_SPEC_EFFICIENCY"
    assert report["quality_gates"]["non_inferiority"]["passed"] is True
    assert report["efficiency"]["wall_time_reduction_pct"] == 38.89
    assert report["efficiency"]["estimated_cost_reduction_pct"] == 40.0
    assert validate_compute_efficiency_report(report) == []


def test_blocks_faster_runtime_when_accuracy_or_feature_spec_regresses():
    report = build_compute_efficiency_report(
        job_name="optuna-research-sweep",
        baseline={
            "wall_sec": 3600,
            "est_usd": 8.0,
            "rows": 500_000,
            "features": 106,
        },
        optimized={
            "wall_sec": 900,
            "est_usd": 2.0,
            "rows": 500_000,
            "features": 92,
        },
        quality={
            "ic_delta": -0.01,
            "precision_at_k_delta": -0.04,
            "hit_rate_delta": -0.03,
            "max_drawdown_delta": 2.8,
            "topk_overlap": 0.55,
            "regime_split_passed": False,
            "feature_count_delta": -14,
        },
        generated_at="2026-05-17T00:00:00Z",
    )

    assert report["decision"] == "BLOCK_QUALITY_REGRESSION"
    assert report["quality_gates"]["non_inferiority"]["passed"] is False
    assert report["quality_gates"]["feature_spec_preserved"]["passed"] is False
    assert report["efficiency"]["wall_time_reduction_pct"] == 75.0
    assert validate_compute_efficiency_report(report) == []


def test_flags_no_savings_even_when_quality_is_preserved():
    report = build_compute_efficiency_report(
        job_name="weekly-validation-bundle",
        baseline={"wall_sec": 1000, "est_usd": 1.0, "features": 106},
        optimized={"wall_sec": 1120, "est_usd": 1.15, "features": 106},
        quality={
            "ic_delta": 0.001,
            "precision_at_k_delta": 0.0,
            "hit_rate_delta": 0.0,
            "max_drawdown_delta": 0.0,
            "topk_overlap": 0.9,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
    )

    assert report["decision"] == "KEEP_BASELINE_RUNTIME"
    assert report["quality_gates"]["non_inferiority"]["passed"] is True
    assert report["quality_gates"]["efficiency_gain"]["passed"] is False


def test_normalizes_cloud_run_and_modal_profiles_into_one_compute_shape():
    cloud_run = normalize_compute_profile(
        {
            "provider": "gcp_cloud_run",
            "job_name": "pipeline-v2",
            "wall_sec": 600,
            "cpu": 4,
            "memory_mb": 4096,
            "rows": 850_000,
            "features": 106,
        }
    )
    modal = normalize_compute_profile(
        {
            "provider": "modal",
            "job_name": "monthly-universal-retrain",
            "wall_sec": 3300,
            "compute_sec": 6600,
            "cpu": 2,
            "memory_mb": 8192,
            "gpu": "L4",
            "rows": 1_200_000,
            "features": 106,
            "cache_hit_ratio": 0.78,
        }
    )

    assert cloud_run["provider"] == "gcp_cloud_run"
    assert cloud_run["compute_sec"] == 2400.0
    assert cloud_run["memory_gib"] == 4.0
    assert modal["provider"] == "modal"
    assert modal["compute_sec"] == 6600.0
    assert modal["gpu"] == "L4"
    assert modal["cache_hit_ratio"] == 0.78


def test_build_compute_profile_pair_feeds_efficiency_contract_without_losing_quality_spec():
    pair = build_compute_profile_pair(
        job_name="optuna-research-sweep",
        baseline_profile={
            "provider": "gcp_cloud_run",
            "wall_sec": 3600,
            "cpu": 4,
            "memory_mb": 4096,
            "est_usd": 8.0,
            "rows": 500_000,
            "features": 106,
        },
        optimized_profile={
            "provider": "modal",
            "wall_sec": 1800,
            "compute_sec": 5400,
            "cpu": 2,
            "memory_mb": 4096,
            "est_usd": 4.6,
            "rows": 500_000,
            "features": 106,
        },
        quality={
            "ic_delta": 0.001,
            "precision_at_k_delta": 0.002,
            "hit_rate_delta": 0.0,
            "max_drawdown_delta": 0.1,
            "topk_overlap": 0.82,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
    )

    assert pair["report"]["decision"] == "ACCEPT_HIGH_SPEC_EFFICIENCY"
    assert pair["baseline_profile"]["compute_sec"] == 14400.0
    assert pair["optimized_profile"]["compute_sec"] == 5400.0
    assert pair["report"]["baseline"]["features"] == 106


def test_monthly_stage_timing_flags_8103_second_regression_and_preserves_required_stages():
    report = build_monthly_retrain_stage_timing_report(
        run_id="monthly-2026-05-17",
        generated_at="2026-05-18T00:00:00Z",
        stages={
            "feature_selection": 4194.8,
            "optuna_k_sweep": 1014.3,
            "target_permutation": 758.6,
            "signal_sanity_gate": 478.7,
            "ft_transformer": 862.0,
            "patchtst": 506.2,
            "shap_audit": 288.4,
        },
        baseline_stages={
            "feature_selection": 2571.1,
            "optuna_k_sweep": 1014.3,
            "target_permutation": 758.6,
            "signal_sanity_gate": 478.7,
            "ft_transformer": 862.0,
            "patchtst": 506.2,
            "shap_audit": 288.4,
        },
    )

    assert report["status"] == "warn"
    assert report["severity"] == "warn"
    assert report["total_sec"] == 8103.0
    assert report["reason"] == "monthly_retrain_runtime_regression"
    assert "feature_selection" in report["regressed_stages"]
    assert report["missing_required_stages"] == []
    assert report["quality_principle"].startswith("timing optimization cannot reduce feature count")


def test_monthly_stage_timing_fails_when_required_stage_is_missing():
    report = build_monthly_retrain_stage_timing_report(
        run_id="monthly-missing-stage",
        stages={"feature_selection": 10.0},
    )

    assert report["status"] == "fail"
    assert report["severity"] == "error"
    assert "optuna_k_sweep" in report["missing_required_stages"]
