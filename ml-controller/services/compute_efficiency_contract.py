"""High-spec compute efficiency contract.

The goal is to reduce total Cloud Run + Modal cost without lowering model,
feature, or validation quality.
"""

from __future__ import annotations

from typing import Any


COMPUTE_EFFICIENCY_SCHEMA_VERSION = "compute-efficiency-contract-v1"

DEFAULT_QUALITY_POLICY = {
    "max_ic_drop": 0.002,
    "max_precision_at_k_drop": 0.005,
    "max_hit_rate_drop": 0.005,
    "max_drawdown_worsening_pct": 0.5,
    "min_topk_overlap": 0.70,
    "min_wall_time_reduction_pct": 5.0,
    "min_cost_reduction_pct": 5.0,
}

REQUIRED_MONTHLY_RETRAIN_STAGES = [
    "feature_selection",
    "optuna_k_sweep",
    "target_permutation",
    "signal_sanity_gate",
    "ft_transformer",
    "patchtst",
    "shap_audit",
]


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _round(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def _pct_reduction(baseline: float, optimized: float) -> float:
    if baseline <= 0:
        return 0.0
    return ((baseline - optimized) / baseline) * 100.0


def normalize_compute_profile(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize GCP Cloud Run and Modal observations into one profile shape."""
    wall_sec = _num(raw.get("wall_sec") or raw.get("duration_sec") or raw.get("elapsed_sec"))
    cpu = _num(raw.get("cpu"), default=1.0)
    memory_mb = int(_num(raw.get("memory_mb") or raw.get("memoryMiB") or raw.get("memory"), default=0.0))
    explicit_compute_sec = raw.get("compute_sec")
    compute_sec = _num(explicit_compute_sec, default=wall_sec * max(cpu, 1.0)) if explicit_compute_sec is not None else wall_sec * max(cpu, 1.0)
    memory_gib = memory_mb / 1024.0 if memory_mb else 0.0
    return {
        "provider": str(raw.get("provider") or "unknown"),
        "job_name": str(raw.get("job_name") or raw.get("function_name") or raw.get("name") or "unknown"),
        "wall_sec": _round(wall_sec, 3),
        "compute_sec": _round(compute_sec, 3),
        "cpu": _round(cpu, 3),
        "memory_mb": memory_mb,
        "memory_gib": _round(memory_gib, 3),
        "gpu": raw.get("gpu"),
        "est_usd": _round(_num(raw.get("est_usd")), 6),
        "rows": int(_num(raw.get("rows"), default=0.0)),
        "features": int(_num(raw.get("features"), default=0.0)),
        "symbols": int(_num(raw.get("symbols"), default=0.0)),
        "trials": int(_num(raw.get("trials"), default=0.0)),
        "cache_hit_ratio": raw.get("cache_hit_ratio"),
        "meta": raw.get("meta") if isinstance(raw.get("meta"), dict) else {},
    }


def _gate(passed: bool, metrics: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "passed": bool(passed),
        "reason": reason,
        "metrics": metrics,
    }


def build_compute_efficiency_report(
    *,
    job_name: str,
    baseline: dict[str, Any],
    optimized: dict[str, Any],
    quality: dict[str, Any],
    generated_at: str | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    active_policy = {**DEFAULT_QUALITY_POLICY, **(policy or {})}

    wall_reduction = _pct_reduction(_num(baseline.get("wall_sec")), _num(optimized.get("wall_sec")))
    cost_reduction = _pct_reduction(_num(baseline.get("est_usd")), _num(optimized.get("est_usd")))
    cpu_reduction = _pct_reduction(_num(baseline.get("cpu_sec")), _num(optimized.get("cpu_sec")))
    gpu_reduction = _pct_reduction(_num(baseline.get("gpu_sec")), _num(optimized.get("gpu_sec")))

    ic_delta = _num(quality.get("ic_delta"))
    precision_delta = _num(quality.get("precision_at_k_delta"))
    hit_delta = _num(quality.get("hit_rate_delta"))
    drawdown_delta = _num(quality.get("max_drawdown_delta"))
    topk_overlap = _num(quality.get("topk_overlap"))
    feature_count_delta = _num(quality.get("feature_count_delta"))

    non_inferior = (
        ic_delta >= -float(active_policy["max_ic_drop"])
        and precision_delta >= -float(active_policy["max_precision_at_k_drop"])
        and hit_delta >= -float(active_policy["max_hit_rate_drop"])
        and drawdown_delta <= float(active_policy["max_drawdown_worsening_pct"])
        and topk_overlap >= float(active_policy["min_topk_overlap"])
        and quality.get("regime_split_passed") is True
    )
    feature_spec_preserved = feature_count_delta >= 0
    efficiency_gain = (
        wall_reduction >= float(active_policy["min_wall_time_reduction_pct"])
        or cost_reduction >= float(active_policy["min_cost_reduction_pct"])
    )

    quality_gates = {
        "non_inferiority": _gate(
            non_inferior,
            {
                "ic_delta": _round(ic_delta, 4),
                "precision_at_k_delta": _round(precision_delta, 4),
                "hit_rate_delta": _round(hit_delta, 4),
                "max_drawdown_delta": _round(drawdown_delta, 4),
                "topk_overlap": _round(topk_overlap, 4),
                "regime_split_passed": quality.get("regime_split_passed") is True,
            },
            "quality_preserved" if non_inferior else "quality_regressed",
        ),
        "feature_spec_preserved": _gate(
            feature_spec_preserved,
            {
                "feature_count_delta": int(feature_count_delta),
                "baseline_features": baseline.get("features"),
                "optimized_features": optimized.get("features"),
            },
            "feature_spec_preserved" if feature_spec_preserved else "feature_spec_reduced",
        ),
        "efficiency_gain": _gate(
            efficiency_gain,
            {
                "wall_time_reduction_pct": _round(wall_reduction),
                "estimated_cost_reduction_pct": _round(cost_reduction),
                "min_wall_time_reduction_pct": float(active_policy["min_wall_time_reduction_pct"]),
                "min_cost_reduction_pct": float(active_policy["min_cost_reduction_pct"]),
            },
            "runtime_or_cost_improved" if efficiency_gain else "no_material_efficiency_gain",
        ),
    }

    if not non_inferior or not feature_spec_preserved:
        decision = "BLOCK_QUALITY_REGRESSION"
    elif not efficiency_gain:
        decision = "KEEP_BASELINE_RUNTIME"
    else:
        decision = "ACCEPT_HIGH_SPEC_EFFICIENCY"

    return {
        "schema_version": COMPUTE_EFFICIENCY_SCHEMA_VERSION,
        "generated_at": generated_at,
        "job_name": str(job_name),
        "decision": decision,
        "baseline": baseline,
        "optimized": optimized,
        "quality": quality,
        "quality_gates": quality_gates,
        "efficiency": {
            "wall_time_reduction_pct": _round(wall_reduction),
            "estimated_cost_reduction_pct": _round(cost_reduction),
            "cpu_sec_reduction_pct": _round(cpu_reduction),
            "gpu_sec_reduction_pct": _round(gpu_reduction),
        },
        "policy": active_policy,
        "principle": "preserve_high_spec_quality_before_accepting_runtime_savings",
    }


def build_compute_profile_pair(
    *,
    job_name: str,
    baseline_profile: dict[str, Any],
    optimized_profile: dict[str, Any],
    quality: dict[str, Any],
    generated_at: str | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    baseline = normalize_compute_profile({"job_name": job_name, **baseline_profile})
    optimized = normalize_compute_profile({"job_name": job_name, **optimized_profile})
    report = build_compute_efficiency_report(
        job_name=job_name,
        baseline=baseline,
        optimized=optimized,
        quality=quality,
        generated_at=generated_at,
        policy=policy,
    )
    return {
        "schema_version": "compute-profile-pair-v1",
        "job_name": str(job_name),
        "baseline_profile": baseline,
        "optimized_profile": optimized,
        "quality": quality,
        "report": report,
    }


def _stage_seconds(raw: dict[str, Any], stage: str) -> float:
    value = raw.get(stage)
    if isinstance(value, dict):
        return _num(value.get("sec") or value.get("seconds") or value.get("duration_sec"))
    return _num(value)


def build_monthly_retrain_stage_timing_report(
    *,
    run_id: str,
    stages: dict[str, Any],
    baseline_stages: dict[str, Any] | None = None,
    generated_at: str | None = None,
    regression_wall_sec: float = 7200.0,
    regression_pct: float = 20.0,
) -> dict[str, Any]:
    """Record stage-level timing without accepting lower-quality shortcuts.

    `regression_wall_sec` is intentionally conservative: a monthly retrain over
    two hours is visible as an ops regression even if it completes.
    """

    baseline_stages = baseline_stages or {}
    stage_rows: list[dict[str, Any]] = []
    total_sec = 0.0
    missing: list[str] = []
    regressions: list[str] = []

    for stage in REQUIRED_MONTHLY_RETRAIN_STAGES:
        seconds = _stage_seconds(stages, stage)
        if stage not in stages:
            missing.append(stage)
        total_sec += seconds
        baseline_sec = _stage_seconds(baseline_stages, stage)
        delta_pct = _pct_reduction(baseline_sec, seconds) * -1 if baseline_sec > 0 else None
        if delta_pct is not None and delta_pct > regression_pct:
            regressions.append(stage)
        stage_rows.append(
            {
                "stage": stage,
                "seconds": _round(seconds, 3),
                "baseline_seconds": _round(baseline_sec, 3) if baseline_sec > 0 else None,
                "delta_pct": _round(delta_pct, 2) if delta_pct is not None else None,
            }
        )

    for row in stage_rows:
        row["share_pct"] = _round((_num(row["seconds"]) / total_sec) * 100.0, 2) if total_sec > 0 else 0.0

    status = "ok"
    severity = "info"
    reasons: list[str] = []
    if missing:
        status = "fail"
        severity = "error"
        reasons.append("missing_required_stage_timing")
    if total_sec > regression_wall_sec or regressions:
        status = "fail" if status == "fail" else "warn"
        severity = "error" if status == "fail" else "warn"
        reasons.append("monthly_retrain_runtime_regression")

    return {
        "schema_version": "monthly-retrain-stage-timing-v1",
        "generated_at": generated_at,
        "run_id": str(run_id),
        "job_name": "monthly-universal-retrain",
        "status": status,
        "severity": severity,
        "reason": "+".join(reasons) if reasons else "stage_timing_within_guard",
        "total_sec": _round(total_sec, 3),
        "regression_wall_sec": float(regression_wall_sec),
        "regression_pct": float(regression_pct),
        "missing_required_stages": missing,
        "regressed_stages": regressions,
        "stages": stage_rows,
        "quality_principle": "timing optimization cannot reduce feature count, samples, model families, or validation gates",
    }


def validate_compute_efficiency_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema_version") != COMPUTE_EFFICIENCY_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    gates = report.get("quality_gates") if isinstance(report.get("quality_gates"), dict) else {}
    non_inferior = gates.get("non_inferiority") if isinstance(gates.get("non_inferiority"), dict) else {}
    feature_spec = gates.get("feature_spec_preserved") if isinstance(gates.get("feature_spec_preserved"), dict) else {}
    if report.get("decision") == "ACCEPT_HIGH_SPEC_EFFICIENCY":
        if non_inferior.get("passed") is not True:
            errors.append("accepted_without_non_inferiority")
        if feature_spec.get("passed") is not True:
            errors.append("accepted_without_feature_spec_preserved")
    if report.get("decision") == "BLOCK_QUALITY_REGRESSION":
        if non_inferior.get("passed") is True and feature_spec.get("passed") is True:
            errors.append("blocked_without_quality_regression")
    return errors
