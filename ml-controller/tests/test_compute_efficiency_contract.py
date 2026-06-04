from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.compute_efficiency_contract import (  # noqa: E402
    COMPUTE_EFFICIENCY_SCHEMA_VERSION,
    aggregate_compute_profiles,
    build_compute_efficiency_report,
    build_compute_efficiency_report_from_events,
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


def test_unknown_quality_evidence_needs_review_instead_of_accept_or_regression_block():
    report = build_compute_efficiency_report(
        job_name="monthly-universal-retrain",
        baseline={"wall_sec": 8103.5, "est_usd": 1.2, "features": 106},
        optimized={"wall_sec": 5400.0, "est_usd": 0.8, "features": 106},
        quality={},
    )

    assert report["decision"] == "NEEDS_REVIEW"
    assert report["quality_gates"]["quality_evidence_complete"]["passed"] is False
    assert report["quality_gates"]["quality_evidence_complete"]["reason"] == "quality_evidence_missing"
    assert "ic_delta" in report["quality_gates"]["quality_evidence_complete"]["metrics"]["missing_fields"]
    assert report["quality_gates"]["efficiency_gain"]["passed"] is True
    assert report["observability"]["status"] == "needs_review"
    assert report["observability"]["severity"] == "warn"
    assert report["observability"]["production_blocking"] is False
    assert validate_compute_efficiency_report(report) == []


def test_blocks_faster_runtime_when_artifact_or_scope_spec_regresses():
    report = build_compute_efficiency_report(
        job_name="monthly-universal-retrain",
        baseline={
            "wall_sec": 8103.5,
            "est_usd": 1.2,
            "features": 106,
            "rows": 1_200_000,
            "symbols": 2200,
            "trials": 250,
            "artifact_count": 8,
        },
        optimized={
            "wall_sec": 4100.0,
            "est_usd": 0.7,
            "features": 106,
            "rows": 1_200_000,
            "symbols": 2200,
            "trials": 250,
            "artifact_count": 6,
        },
        quality={
            "ic_delta": 0.001,
            "precision_at_k_delta": 0.002,
            "hit_rate_delta": 0.001,
            "max_drawdown_delta": 0.0,
            "topk_overlap": 0.9,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
    )

    assert report["decision"] == "BLOCK_SPEC_REGRESSION"
    assert report["quality_gates"]["compute_scope_preserved"]["passed"] is False
    assert report["quality_gates"]["compute_scope_preserved"]["reason"] == "artifact_or_scope_reduced"
    assert report["quality_gates"]["compute_scope_preserved"]["metrics"]["artifact_count_delta"] == -2
    assert report["quality_gates"]["non_inferiority"]["passed"] is True
    assert report["observability"]["status"] == "blocked"
    assert report["observability"]["severity"] == "error"
    assert report["observability"]["production_blocking"] is False
    assert validate_compute_efficiency_report(report) == []


def test_compute_efficiency_report_marks_no_savings_as_degraded_observability_only():
    report = build_compute_efficiency_report(
        job_name="daily-pipeline-v2",
        baseline={"wall_sec": 600, "est_usd": 0.10, "features": 106},
        optimized={"wall_sec": 590, "est_usd": 0.099, "features": 106},
        quality={
            "ic_delta": 0.0,
            "precision_at_k_delta": 0.0,
            "hit_rate_delta": 0.0,
            "max_drawdown_delta": 0.0,
            "topk_overlap": 0.9,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
    )

    assert report["decision"] == "KEEP_BASELINE_RUNTIME"
    assert report["observability"]["status"] == "degraded"
    assert report["observability"]["severity"] == "warn"
    assert report["observability"]["production_blocking"] is False
    assert report["observability"]["fail_closed_enabled"] is False


def test_validate_compute_efficiency_report_checks_observability_status_shape():
    report = build_compute_efficiency_report(
        job_name="daily-pipeline-v2",
        baseline={"wall_sec": 600, "est_usd": 0.10, "features": 106},
        optimized={"wall_sec": 590, "est_usd": 0.099, "features": 106},
        quality={
            "ic_delta": 0.0,
            "precision_at_k_delta": 0.0,
            "hit_rate_delta": 0.0,
            "max_drawdown_delta": 0.0,
            "topk_overlap": 0.9,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
    )

    missing = dict(report)
    missing.pop("observability")
    assert "observability_missing" in validate_compute_efficiency_report(missing)

    mismatched = {**report, "observability": {"status": "ok"}}
    assert "observability_status_mismatch" in validate_compute_efficiency_report(mismatched)


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
            "artifact_count": 4,
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
    assert modal["artifact_count"] == 4


def test_normalizes_modal_batch_operational_telemetry_from_meta_and_profile_json():
    profile = normalize_compute_profile(
        {
            "provider": "modal",
            "job_name": "predict_batch_v2",
            "wall_sec": 134.972,
            "compute_sec": 539.888,
            "symbols": 64,
            "profile_json": (
                '{"meta":{"chunk_size":20,"chunk_count":4,'
                '"result_error_rate":0.015625,"batch_error_rate":0.01,'
                '"model_cache_hit_ratio":0.75,'
                '"state_space_overlay_mode":"shadow",'
                '"finalizer_mode":"inline_pure_payload"}}'
            ),
        }
    )

    assert profile["chunk_size"] == 20
    assert profile["chunk_count"] == 4
    assert profile["result_error_rate"] == 0.015625
    assert profile["batch_error_rate"] == 0.01
    assert profile["model_cache_hit_ratio"] == 0.75
    assert profile["cache_hit_ratio"] == 0.75
    assert profile["overlay_mode"] == "shadow"
    assert profile["finalizer_mode"] == "inline_pure_payload"


def test_aggregate_compute_profiles_summarizes_operational_telemetry():
    aggregate = aggregate_compute_profiles(
        [
            {
                "provider": "modal",
                "job_name": "predict_batch_v2",
                "wall_sec": 100,
                "compute_sec": 300,
                "symbols": 40,
                "meta": {
                    "chunk_size": 20,
                    "chunk_count": 2,
                    "result_error_rate": 0.05,
                    "batch_error_rate": 0.025,
                    "model_cache_hit_ratio": 0.80,
                    "state_space_overlay_mode": "blocking",
                },
            },
            {
                "provider": "modal",
                "job_name": "predict_batch_v2",
                "wall_sec": 80,
                "compute_sec": 160,
                "symbols": 20,
                "meta": {
                    "chunk_size": 40,
                    "chunk_count": 1,
                    "result_error_rate": 0.0,
                    "batch_error_rate": 0.0,
                    "model_cache_hit_ratio": 0.90,
                    "state_space_overlay_mode": "shadow",
                    "finalizer_mode": "inline_pure_payload",
                },
            },
        ],
        job_name="predict_batch_v2",
    )

    assert aggregate["chunk_count"] == 3
    assert aggregate["chunk_sizes"] == [20, 40]
    assert aggregate["result_error_rate"] == 0.033333
    assert aggregate["batch_error_rate"] == 0.016667
    assert aggregate["model_cache_hit_ratio"] == 0.85
    assert aggregate["cache_hit_ratio"] == 0.85
    assert aggregate["overlay_modes"] == ["blocking", "shadow"]
    assert aggregate["finalizer_modes"] == ["inline_pure_payload"]


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


def test_compute_efficiency_report_includes_operational_regression_context():
    report = build_compute_efficiency_report(
        job_name="daily-pipeline-v2",
        baseline={
            "wall_sec": 600,
            "est_usd": 0.10,
            "features": 106,
            "chunk_size": 20,
            "chunk_count": 4,
            "result_error_rate": 0.02,
            "model_cache_hit_ratio": 0.70,
            "overlay_modes": ["blocking"],
        },
        optimized={
            "wall_sec": 420,
            "est_usd": 0.08,
            "features": 106,
            "chunk_size": 40,
            "chunk_count": 2,
            "result_error_rate": 0.01,
            "model_cache_hit_ratio": 0.85,
            "overlay_modes": ["shadow"],
        },
        quality={
            "ic_delta": 0.0,
            "precision_at_k_delta": 0.0,
            "hit_rate_delta": 0.0,
            "max_drawdown_delta": 0.0,
            "topk_overlap": 0.9,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
    )

    assert report["decision"] == "ACCEPT_HIGH_SPEC_EFFICIENCY"
    assert report["operational"]["deltas"]["chunk_size_changed"] is True
    assert report["operational"]["deltas"]["chunk_count_delta"] == -2
    assert report["operational"]["deltas"]["result_error_rate_delta"] == -0.01
    assert report["operational"]["deltas"]["model_cache_hit_ratio_delta"] == 0.15
    assert report["operational"]["deltas"]["overlay_mode_changed"] is True


def test_aggregate_compute_profiles_preserves_scope_and_adds_costs():
    aggregate = aggregate_compute_profiles(
        [
            {
                "provider": "modal",
                "job_name": "feature_selection_pipeline",
                "wall_sec": 1200,
                "compute_sec": 4800,
                "cpu": 4,
                "memory_mb": 8192,
                "est_usd": 0.1,
                "features": 106,
                "trials": 50,
                "artifact_count": 4,
            },
            {
                "provider": "modal",
                "job_name": "feature_selection_pipeline",
                "wall_sec": 900,
                "compute_sec": 3600,
                "cpu": 4,
                "memory_mb": 8192,
                "est_usd": 0.08,
                "features": 106,
                "trials": 50,
                "artifact_count": 4,
            },
        ],
        job_name="feature_selection_pipeline",
        generated_at="2026-05-18T00:00:00Z",
    )

    assert aggregate["provider"] == "modal"
    assert aggregate["event_count"] == 2
    assert aggregate["wall_sec"] == 2100.0
    assert aggregate["compute_sec"] == 8400.0
    assert aggregate["est_usd"] == 0.18
    assert aggregate["features"] == 106
    assert aggregate["trials"] == 100
    assert aggregate["artifact_count"] == 8


def test_build_compute_efficiency_report_from_events_accepts_high_spec_speedup():
    report = build_compute_efficiency_report_from_events(
        job_name="monthly-universal-retrain",
        baseline_events=[
            {
                "provider": "modal",
                "job_name": "train_patchtst_universal",
                "wall_sec": 3310,
                "compute_sec": 3310,
                "est_usd": 0.8,
                "features": 106,
                "symbols": 2200,
            },
            {
                "provider": "modal",
                "job_name": "feature_selection_pipeline",
                "wall_sec": 3546,
                "compute_sec": 14184,
                "est_usd": 0.25,
                "features": 106,
                "trials": 250,
            },
        ],
        optimized_events=[
            {
                "provider": "modal",
                "job_name": "train_patchtst_universal",
                "wall_sec": 2400,
                "compute_sec": 2400,
                "est_usd": 0.58,
                "features": 106,
                "symbols": 2200,
            },
            {
                "provider": "modal",
                "job_name": "feature_selection_pipeline",
                "wall_sec": 2100,
                "compute_sec": 8400,
                "est_usd": 0.18,
                "features": 106,
                "trials": 250,
            },
        ],
        quality={
            "ic_delta": 0.001,
            "precision_at_k_delta": 0.002,
            "hit_rate_delta": 0.0,
            "max_drawdown_delta": 0.0,
            "topk_overlap": 0.86,
            "regime_split_passed": True,
            "feature_count_delta": 0,
        },
        generated_at="2026-05-18T00:00:00Z",
    )

    assert report["decision"] == "ACCEPT_HIGH_SPEC_EFFICIENCY"
    assert report["baseline"]["event_count"] == 2
    assert report["optimized"]["trials"] == 250
    assert report["efficiency"]["wall_time_reduction_pct"] == 34.36
    assert validate_compute_efficiency_report(report) == []


def test_build_compute_efficiency_report_from_events_blocks_quality_regression():
    report = build_compute_efficiency_report_from_events(
        job_name="feature_selection_pipeline",
        baseline_events=[
            {"provider": "modal", "wall_sec": 3546, "est_usd": 0.25, "features": 106, "trials": 250},
        ],
        optimized_events=[
            {"provider": "modal", "wall_sec": 1200, "est_usd": 0.1, "features": 80, "trials": 100},
        ],
        quality={
            "ic_delta": -0.004,
            "precision_at_k_delta": -0.02,
            "hit_rate_delta": -0.01,
            "max_drawdown_delta": 1.0,
            "topk_overlap": 0.65,
            "regime_split_passed": False,
            "feature_count_delta": -26,
        },
    )

    assert report["decision"] == "BLOCK_QUALITY_REGRESSION"
    assert report["quality_gates"]["feature_spec_preserved"]["passed"] is False


def test_monthly_stage_timing_flags_8103_second_regression_and_preserves_required_stages():
    report = build_monthly_retrain_stage_timing_report(
        run_id="monthly-2026-05-17",
        generated_at="2026-05-18T00:00:00Z",
        stages={
            "feature_selection": 4194.8,
            "optuna_k_sweep": 1014.3,
            "target_permutation": 758.6,
            "signal_sanity_gate": 478.7,
            "tree_models": 862.0,
            "dlinear": 0.0,
            "patchtst": 506.2,
            "l3_artifact_registry": 0.0,
            "shap_audit": 288.4,
        },
        baseline_stages={
            "feature_selection": 2571.1,
            "optuna_k_sweep": 1014.3,
            "target_permutation": 758.6,
            "signal_sanity_gate": 478.7,
            "tree_models": 862.0,
            "dlinear": 0.0,
            "patchtst": 506.2,
            "l3_artifact_registry": 0.0,
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
