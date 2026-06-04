"""High-spec compute efficiency contract.

The goal is to reduce total Cloud Run + Modal cost without lowering model,
feature, or validation quality.
"""

from __future__ import annotations

import json
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
    "tree_models",
    "dlinear",
    "patchtst",
    "l3_artifact_registry",
    "shap_audit",
]

REQUIRED_QUALITY_EVIDENCE_FIELDS = [
    "ic_delta",
    "precision_at_k_delta",
    "hit_rate_delta",
    "max_drawdown_delta",
    "topk_overlap",
    "regime_split_passed",
    "feature_count_delta",
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


def _json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _first_value(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _float_or_none(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _int_or_none(value: Any) -> int | None:
    numeric = _float_or_none(value)
    return int(numeric) if numeric is not None else None


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _first_float(*values: Any) -> float | None:
    for value in values:
        numeric = _float_or_none(value)
        if numeric is not None:
            return numeric
    return None


def _first_int(*values: Any) -> int | None:
    for value in values:
        numeric = _int_or_none(value)
        if numeric is not None:
            return numeric
    return None


def _ratio(numerator: Any, denominator: Any) -> float | None:
    top = _float_or_none(numerator)
    bottom = _float_or_none(denominator)
    if top is None or bottom is None or bottom <= 0:
        return None
    return top / bottom


def _int_list(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    out: list[int] = []
    for item in value:
        numeric = _int_or_none(item)
        if numeric is not None and numeric > 0 and numeric not in out:
            out.append(numeric)
    return out


def _profile_meta(raw: dict[str, Any], profile_json: dict[str, Any]) -> dict[str, Any]:
    raw_meta = _json_dict(raw.get("meta"))
    profile_meta = _json_dict(profile_json.get("meta"))
    return {**profile_meta, **raw_meta}


def _nested_dict(*values: Any) -> dict[str, Any]:
    for value in values:
        nested = _json_dict(value)
        if nested:
            return nested
    return {}


def normalize_compute_profile(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize GCP Cloud Run and Modal observations into one profile shape."""
    profile_json = _json_dict(raw.get("profile_json"))
    source = {**profile_json, **raw}
    meta = _profile_meta(raw, profile_json)
    batch_metrics = _nested_dict(source.get("batch_metrics"), meta.get("batch_metrics"))
    batch_counts = _nested_dict(batch_metrics.get("batch"))
    model_cache = _nested_dict(batch_metrics.get("model_cache"))
    batch_contract = _nested_dict(source.get("batch_contract"), meta.get("batch_contract"))

    wall_sec = _num(source.get("wall_sec") or source.get("duration_sec") or source.get("elapsed_sec"))
    cpu = _num(source.get("cpu"), default=1.0)
    memory_mb = int(_num(source.get("memory_mb") or source.get("memoryMiB") or source.get("memory"), default=0.0))
    explicit_compute_sec = source.get("compute_sec")
    compute_sec = _num(explicit_compute_sec, default=wall_sec * max(cpu, 1.0)) if explicit_compute_sec is not None else wall_sec * max(cpu, 1.0)
    memory_gib = memory_mb / 1024.0 if memory_mb else 0.0
    chunk_size = _first_int(source.get("chunk_size"), meta.get("chunk_size"), batch_contract.get("chunk_size"))
    chunk_count = _first_int(source.get("chunk_count"), meta.get("chunk_count"))
    raw_chunk_sizes = _int_list(_first_value(source.get("chunk_sizes"), meta.get("chunk_sizes")))
    chunk_sizes = [chunk_size] if chunk_size else raw_chunk_sizes
    if chunk_count is None and raw_chunk_sizes:
        chunk_count = len(raw_chunk_sizes)
    result_error_rate = _first_float(
        source.get("result_error_rate"),
        meta.get("result_error_rate"),
        _ratio(
            _first_value(source.get("result_error_count"), meta.get("result_error_count")),
            _first_value(source.get("result_count"), meta.get("result_count")),
        ),
    )
    batch_error_rate = _first_float(
        source.get("batch_error_rate"),
        meta.get("batch_error_rate"),
        batch_metrics.get("batch_error_rate"),
        _ratio(batch_counts.get("n_error"), batch_counts.get("n_input")),
    )
    model_cache_hit_ratio = _first_float(
        source.get("model_cache_hit_ratio"),
        meta.get("model_cache_hit_ratio"),
        batch_metrics.get("model_cache_hit_ratio"),
        _ratio(model_cache.get("hits"), _num(model_cache.get("hits")) + _num(model_cache.get("misses"))),
    )
    cache_hit_ratio = _first_float(source.get("cache_hit_ratio"), meta.get("cache_hit_ratio"), model_cache_hit_ratio)
    return {
        "provider": str(source.get("provider") or "unknown"),
        "job_name": str(source.get("job_name") or source.get("function_name") or source.get("name") or "unknown"),
        "wall_sec": _round(wall_sec, 3),
        "compute_sec": _round(compute_sec, 3),
        "cpu": _round(cpu, 3),
        "memory_mb": memory_mb,
        "memory_gib": _round(memory_gib, 3),
        "gpu": source.get("gpu"),
        "est_usd": _round(_num(source.get("est_usd")), 6),
        "rows": int(_num(source.get("rows"), default=0.0)),
        "features": int(_num(source.get("features"), default=0.0)),
        "symbols": int(_num(source.get("symbols"), default=0.0)),
        "trials": int(_num(source.get("trials"), default=0.0)),
        "artifact_count": int(_num(_first_value(source.get("artifact_count"), meta.get("artifact_count")), default=0.0)),
        "cache_hit_ratio": _round(cache_hit_ratio, 6) if cache_hit_ratio is not None else None,
        "chunk_size": chunk_size,
        "chunk_sizes": sorted(set(chunk_sizes)),
        "chunk_count": chunk_count,
        "result_error_rate": _round(result_error_rate, 6) if result_error_rate is not None else None,
        "batch_error_rate": _round(batch_error_rate, 6) if batch_error_rate is not None else None,
        "model_cache_hit_ratio": _round(model_cache_hit_ratio, 6) if model_cache_hit_ratio is not None else None,
        "overlay_mode": _str_or_none(
            _first_value(
                source.get("overlay_mode"),
                source.get("state_space_overlay_mode"),
                meta.get("overlay_mode"),
                meta.get("state_space_overlay_mode"),
            )
        ),
        "finalizer_mode": _str_or_none(_first_value(source.get("finalizer_mode"), meta.get("finalizer_mode"))),
        "function_call_id": _str_or_none(
            _first_value(
                source.get("function_call_id"),
                source.get("modal_function_call_id"),
                source.get("call_id"),
                meta.get("function_call_id"),
                meta.get("modal_function_call_id"),
                meta.get("call_id"),
            )
        ),
        "meta": meta,
    }


def _weighted_average_rate(profiles: list[dict[str, Any]], key: str) -> float | None:
    weighted_total = 0.0
    weight_total = 0
    unweighted: list[float] = []
    for profile in profiles:
        value = _float_or_none(profile.get(key))
        if value is None:
            continue
        weight = int(_num(profile.get("symbols"), default=0.0)) or int(_num(profile.get("rows"), default=0.0))
        if weight > 0:
            weighted_total += value * weight
            weight_total += weight
        else:
            unweighted.append(value)
    if weight_total > 0:
        return _round(weighted_total / weight_total, 6)
    if unweighted:
        return _round(sum(unweighted) / len(unweighted), 6)
    return None


def _average_optional(values: list[Any], digits: int = 4) -> float | None:
    numeric = [_num(value) for value in values if value is not None]
    return _round(sum(numeric) / len(numeric), digits) if numeric else None


def aggregate_compute_profiles(
    profiles: list[dict[str, Any]],
    *,
    job_name: str,
    provider: str | None = None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Aggregate compute_profile_events rows into one comparable profile.

    Events can be raw D1 rows, cost-event-derived profiles, or normalized
    profile dicts. Aggregation is additive for runtime/cost/count fields and
    conservative for spec fields: max feature/symbol/trial counts are kept so
    an optimized run cannot look equivalent after silently shrinking scope.
    """
    normalized = [normalize_compute_profile(p) for p in profiles or []]
    providers = sorted({str(p.get("provider") or "unknown") for p in normalized})
    selected_provider = provider or (providers[0] if len(providers) == 1 else "mixed")
    event_count = len(normalized)
    wall_sec = sum(_num(p.get("wall_sec")) for p in normalized)
    compute_sec = sum(_num(p.get("compute_sec")) for p in normalized)
    est_usd = sum(_num(p.get("est_usd")) for p in normalized)
    rows = sum(int(_num(p.get("rows"))) for p in normalized)
    features = max([int(_num(p.get("features"))) for p in normalized] or [0])
    symbols = max([int(_num(p.get("symbols"))) for p in normalized] or [0])
    trials = sum(int(_num(p.get("trials"))) for p in normalized)
    artifact_count = sum(int(_num(p.get("artifact_count"))) for p in normalized)
    cache_values = [
        _num(p.get("cache_hit_ratio"))
        for p in normalized
        if p.get("cache_hit_ratio") is not None
    ]
    model_cache_values = [
        _num(p.get("model_cache_hit_ratio"))
        for p in normalized
        if p.get("model_cache_hit_ratio") is not None
    ]
    chunk_size_values: set[int] = set()
    for profile in normalized:
        for size in profile.get("chunk_sizes") or ([profile.get("chunk_size")] if profile.get("chunk_size") else []):
            numeric_size = _int_or_none(size)
            if numeric_size is not None and numeric_size > 0:
                chunk_size_values.add(numeric_size)
    chunk_sizes = sorted(chunk_size_values)
    chunk_count = sum(int(_num(p.get("chunk_count"))) for p in normalized)
    overlay_modes = sorted({str(p.get("overlay_mode")) for p in normalized if p.get("overlay_mode")})
    finalizer_modes = sorted({str(p.get("finalizer_mode")) for p in normalized if p.get("finalizer_mode")})
    function_call_ids = sorted({str(p.get("function_call_id")) for p in normalized if p.get("function_call_id")})
    cpu_values = [_num(p.get("cpu")) for p in normalized if p.get("cpu") is not None]
    memory_values = [int(_num(p.get("memory_mb"))) for p in normalized if p.get("memory_mb")]
    gpus = sorted({str(p.get("gpu")) for p in normalized if p.get("gpu")})
    return {
        "provider": selected_provider,
        "job_name": str(job_name),
        "generated_at": generated_at,
        "event_count": event_count,
        "wall_sec": _round(wall_sec, 3),
        "compute_sec": _round(compute_sec, 3),
        "cpu_sec": _round(compute_sec, 3),
        "cpu": _round(max(cpu_values), 3) if cpu_values else 0.0,
        "memory_mb": max(memory_values) if memory_values else 0,
        "gpu": ",".join(gpus) if gpus else None,
        "est_usd": _round(est_usd, 6),
        "rows": rows,
        "features": features,
        "symbols": symbols,
        "trials": trials,
        "artifact_count": artifact_count,
        "cache_hit_ratio": _average_optional(cache_values, 4) or _average_optional(model_cache_values, 4),
        "chunk_size": chunk_sizes[0] if len(chunk_sizes) == 1 else None,
        "chunk_sizes": chunk_sizes,
        "chunk_count": chunk_count,
        "result_error_rate": _weighted_average_rate(normalized, "result_error_rate"),
        "batch_error_rate": _weighted_average_rate(normalized, "batch_error_rate"),
        "model_cache_hit_ratio": _average_optional(model_cache_values, 4),
        "overlay_modes": overlay_modes,
        "finalizer_modes": finalizer_modes,
        "function_call_ids": function_call_ids,
        "providers": providers,
        "event_names": sorted({str(p.get("job_name") or "unknown") for p in normalized}),
    }


def build_compute_efficiency_report_from_events(
    *,
    job_name: str,
    baseline_events: list[dict[str, Any]],
    optimized_events: list[dict[str, Any]],
    quality: dict[str, Any],
    generated_at: str | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build an efficiency report from raw event/profile lists."""
    baseline = aggregate_compute_profiles(
        baseline_events,
        job_name=job_name,
        generated_at=generated_at,
    )
    optimized = aggregate_compute_profiles(
        optimized_events,
        job_name=job_name,
        generated_at=generated_at,
    )
    return build_compute_efficiency_report(
        job_name=job_name,
        baseline=baseline,
        optimized=optimized,
        quality=quality,
        generated_at=generated_at,
        policy=policy,
    )


def _gate(passed: bool, metrics: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "passed": bool(passed),
        "reason": reason,
        "metrics": metrics,
    }


def _missing_quality_evidence_fields(quality: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    for field in REQUIRED_QUALITY_EVIDENCE_FIELDS:
        if field not in quality or quality.get(field) is None:
            missing.append(field)
            continue
        if field == "regime_split_passed" and not isinstance(quality.get(field), bool):
            missing.append(field)
    return missing


def _mode_list(profile: dict[str, Any], plural_key: str, singular_key: str) -> list[str]:
    plural = profile.get(plural_key)
    if isinstance(plural, list):
        return sorted({str(item) for item in plural if item is not None and str(item)})
    singular = profile.get(singular_key)
    return [str(singular)] if singular is not None and str(singular) else []


def _ids_list(profile: dict[str, Any], plural_key: str, singular_key: str) -> list[str]:
    return _mode_list(profile, plural_key, singular_key)


def _operational_snapshot(profile: dict[str, Any]) -> dict[str, Any]:
    snapshot = {
        "event_count": profile.get("event_count"),
        "chunk_size": profile.get("chunk_size"),
        "chunk_sizes": profile.get("chunk_sizes") if isinstance(profile.get("chunk_sizes"), list) else [],
        "chunk_count": profile.get("chunk_count"),
        "result_error_rate": profile.get("result_error_rate"),
        "batch_error_rate": profile.get("batch_error_rate"),
        "cache_hit_ratio": profile.get("cache_hit_ratio"),
        "model_cache_hit_ratio": profile.get("model_cache_hit_ratio"),
        "overlay_modes": _mode_list(profile, "overlay_modes", "overlay_mode"),
        "finalizer_modes": _mode_list(profile, "finalizer_modes", "finalizer_mode"),
        "function_call_ids": _ids_list(profile, "function_call_ids", "function_call_id"),
        "event_names": profile.get("event_names") if isinstance(profile.get("event_names"), list) else [],
    }
    return {
        key: value
        for key, value in snapshot.items()
        if value is not None and value != [] and value != ""
    }


def _numeric_delta(baseline: dict[str, Any], optimized: dict[str, Any], key: str, digits: int = 6) -> float | None:
    baseline_value = _float_or_none(baseline.get(key))
    optimized_value = _float_or_none(optimized.get(key))
    if baseline_value is None or optimized_value is None:
        return None
    return _round(optimized_value - baseline_value, digits)


def _operational_deltas(baseline: dict[str, Any], optimized: dict[str, Any]) -> dict[str, Any]:
    baseline_overlay_modes = _mode_list(baseline, "overlay_modes", "overlay_mode")
    optimized_overlay_modes = _mode_list(optimized, "overlay_modes", "overlay_mode")
    baseline_finalizer_modes = _mode_list(baseline, "finalizer_modes", "finalizer_mode")
    optimized_finalizer_modes = _mode_list(optimized, "finalizer_modes", "finalizer_mode")
    return {
        "chunk_size_changed": baseline.get("chunk_size") != optimized.get("chunk_size"),
        "chunk_count_delta": _numeric_delta(baseline, optimized, "chunk_count", digits=0),
        "result_error_rate_delta": _numeric_delta(baseline, optimized, "result_error_rate"),
        "batch_error_rate_delta": _numeric_delta(baseline, optimized, "batch_error_rate"),
        "cache_hit_ratio_delta": _numeric_delta(baseline, optimized, "cache_hit_ratio"),
        "model_cache_hit_ratio_delta": _numeric_delta(baseline, optimized, "model_cache_hit_ratio"),
        "overlay_mode_changed": baseline_overlay_modes != optimized_overlay_modes,
        "finalizer_mode_changed": baseline_finalizer_modes != optimized_finalizer_modes,
    }


def _scope_delta(baseline: dict[str, Any], optimized: dict[str, Any], key: str) -> int | None:
    baseline_value = _int_or_none(baseline.get(key))
    optimized_value = _int_or_none(optimized.get(key))
    if baseline_value is None or optimized_value is None:
        return None
    if baseline_value <= 0 and optimized_value <= 0:
        return None
    return int(optimized_value - baseline_value)


def _compute_scope_metrics(baseline: dict[str, Any], optimized: dict[str, Any]) -> dict[str, Any]:
    deltas = {
        "rows_delta": _scope_delta(baseline, optimized, "rows"),
        "symbols_delta": _scope_delta(baseline, optimized, "symbols"),
        "trials_delta": _scope_delta(baseline, optimized, "trials"),
        "artifact_count_delta": _scope_delta(baseline, optimized, "artifact_count"),
    }
    return {
        **deltas,
        "baseline_rows": baseline.get("rows"),
        "optimized_rows": optimized.get("rows"),
        "baseline_symbols": baseline.get("symbols"),
        "optimized_symbols": optimized.get("symbols"),
        "baseline_trials": baseline.get("trials"),
        "optimized_trials": optimized.get("trials"),
        "baseline_artifact_count": baseline.get("artifact_count"),
        "optimized_artifact_count": optimized.get("artifact_count"),
    }


def _compute_scope_preserved(metrics: dict[str, Any]) -> bool:
    for key in ("rows_delta", "symbols_delta", "trials_delta", "artifact_count_delta"):
        value = metrics.get(key)
        if value is not None and value < 0:
            return False
    return True


def _observability_status(decision: str) -> dict[str, Any]:
    status_by_decision = {
        "ACCEPT_HIGH_SPEC_EFFICIENCY": "ok",
        "NEEDS_REVIEW": "needs_review",
        "KEEP_BASELINE_RUNTIME": "degraded",
        "BLOCK_QUALITY_REGRESSION": "blocked",
        "BLOCK_SPEC_REGRESSION": "blocked",
    }
    severity_by_status = {
        "ok": "info",
        "needs_review": "warn",
        "degraded": "warn",
        "blocked": "error",
    }
    action_by_status = {
        "ok": "monitor_optimized_runtime",
        "needs_review": "attach_quality_evidence_before_accepting_speedup",
        "degraded": "keep_baseline_runtime_until_efficiency_improves",
        "blocked": "do_not_promote_optimized_runtime_without_review",
    }
    status = status_by_decision.get(decision, "needs_review")
    return {
        "status": status,
        "severity": severity_by_status[status],
        "decision": decision,
        "production_blocking": False,
        "fail_closed_enabled": False,
        "recommended_action": action_by_status[status],
        "principle": "surface_compute_risk_without_blocking_production",
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
    quality = quality or {}
    active_policy = {**DEFAULT_QUALITY_POLICY, **(policy or {})}
    missing_quality_fields = _missing_quality_evidence_fields(quality)
    quality_evidence_complete = not missing_quality_fields

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
        quality_evidence_complete
        and ic_delta >= -float(active_policy["max_ic_drop"])
        and precision_delta >= -float(active_policy["max_precision_at_k_drop"])
        and hit_delta >= -float(active_policy["max_hit_rate_drop"])
        and drawdown_delta <= float(active_policy["max_drawdown_worsening_pct"])
        and topk_overlap >= float(active_policy["min_topk_overlap"])
        and quality.get("regime_split_passed") is True
    )
    feature_spec_preserved = quality_evidence_complete and feature_count_delta >= 0
    efficiency_gain = (
        wall_reduction >= float(active_policy["min_wall_time_reduction_pct"])
        or cost_reduction >= float(active_policy["min_cost_reduction_pct"])
    )
    compute_scope_metrics = _compute_scope_metrics(baseline, optimized)
    compute_scope_preserved = _compute_scope_preserved(compute_scope_metrics)

    quality_gates = {
        "quality_evidence_complete": _gate(
            quality_evidence_complete,
            {
                "required_fields": REQUIRED_QUALITY_EVIDENCE_FIELDS,
                "missing_fields": missing_quality_fields,
            },
            "quality_evidence_complete" if quality_evidence_complete else "quality_evidence_missing",
        ),
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
            (
                "quality_preserved"
                if non_inferior
                else "quality_evidence_missing"
                if not quality_evidence_complete
                else "quality_regressed"
            ),
        ),
        "feature_spec_preserved": _gate(
            feature_spec_preserved,
            {
                "feature_count_delta": int(feature_count_delta),
                "baseline_features": baseline.get("features"),
                "optimized_features": optimized.get("features"),
            },
            (
                "feature_spec_preserved"
                if feature_spec_preserved
                else "quality_evidence_missing"
                if not quality_evidence_complete
                else "feature_spec_reduced"
            ),
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
        "compute_scope_preserved": _gate(
            compute_scope_preserved,
            compute_scope_metrics,
            "artifact_and_scope_preserved" if compute_scope_preserved else "artifact_or_scope_reduced",
        ),
    }

    if not quality_evidence_complete:
        decision = "NEEDS_REVIEW"
    elif not non_inferior or not feature_spec_preserved:
        decision = "BLOCK_QUALITY_REGRESSION"
    elif not compute_scope_preserved:
        decision = "BLOCK_SPEC_REGRESSION"
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
        "operational": {
            "baseline": _operational_snapshot(baseline),
            "optimized": _operational_snapshot(optimized),
            "deltas": _operational_deltas(baseline, optimized),
            "principle": "operational telemetry explains runtime changes without changing quality gates",
        },
        "observability": _observability_status(decision),
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
    decision = str(report.get("decision") or "")
    observability = report.get("observability") if isinstance(report.get("observability"), dict) else {}
    if not observability:
        errors.append("observability_missing")
    else:
        expected_observability = _observability_status(decision)
        if observability.get("status") != expected_observability["status"]:
            errors.append("observability_status_mismatch")
        if observability.get("production_blocking") is not False:
            errors.append("observability_must_be_report_only")
    gates = report.get("quality_gates") if isinstance(report.get("quality_gates"), dict) else {}
    non_inferior = gates.get("non_inferiority") if isinstance(gates.get("non_inferiority"), dict) else {}
    feature_spec = gates.get("feature_spec_preserved") if isinstance(gates.get("feature_spec_preserved"), dict) else {}
    if decision == "ACCEPT_HIGH_SPEC_EFFICIENCY":
        if non_inferior.get("passed") is not True:
            errors.append("accepted_without_non_inferiority")
        if feature_spec.get("passed") is not True:
            errors.append("accepted_without_feature_spec_preserved")
    if decision == "BLOCK_QUALITY_REGRESSION":
        if non_inferior.get("passed") is True and feature_spec.get("passed") is True:
            errors.append("blocked_without_quality_regression")
    if decision == "BLOCK_SPEC_REGRESSION":
        scope_gate = gates.get("compute_scope_preserved") if isinstance(gates.get("compute_scope_preserved"), dict) else {}
        if scope_gate.get("passed") is not False:
            errors.append("blocked_without_spec_regression")
    return errors
