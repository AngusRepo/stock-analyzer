from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


GLOBAL_CONTEXT_READINESS_SCHEMA_VERSION = "global-context-readiness-v1"

REQUIRED_US_LEADING_FIELDS = frozenset({
    "sox_return",
    "gspc_return",
    "dxy_return",
    "vix_close",
    "hy_spread_chg",
})

ALLOWED_LICENSE_STATUSES = frozenset({"allowed", "contract_verified", "internal_allowed"})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _clean_set(values: Any) -> set[str]:
    if not isinstance(values, (list, tuple, set, frozenset)):
        return set()
    return {str(value).strip() for value in values if str(value).strip()}


def _as_float(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def _as_int(value: Any, fallback: int = 999) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def _catalog_summary(catalog: dict[str, Any]) -> dict[str, Any]:
    fields = [field for field in catalog.get("fields", []) if isinstance(field, dict)]
    world_fields = [field for field in fields if str(field.get("namespace") or "") == "world_index"]
    us_fields = [
        field for field in fields
        if str(field.get("market") or "") == "us" or str(field.get("namespace") or "").startswith("us_")
    ]
    return {
        "field_count": len(fields),
        "global_context_fields": sum(1 for field in fields if str(field.get("dataset_lane") or "") == "global_context"),
        "world_index_fields": len(world_fields),
        "us_fields": len(us_fields),
        "world_index_api_keys": sorted(str(field.get("api_key")) for field in world_fields if field.get("api_key")),
        "us_namespaces": sorted({str(field.get("namespace")) for field in us_fields if field.get("namespace")}),
    }


def _check(name: str, passed: bool, value: Any, threshold: Any = None) -> dict[str, Any]:
    out = {"name": name, "passed": bool(passed), "value": value}
    if threshold is not None:
        out["threshold"] = threshold
    return out


def _source_required_fields(source_kind: str) -> set[str]:
    if source_kind == "us_leading":
        return set(REQUIRED_US_LEADING_FIELDS)
    if source_kind == "world_index":
        return {"world_index:close"}
    return set()


def _replacement_surface(source_kind: str, required_passed: bool) -> str:
    if source_kind == "us_leading" and required_passed:
        return "us_leading"
    if source_kind == "world_index":
        return "global_context"
    return "shadow_context"


def _evaluate_source(source: dict[str, Any], *, min_coverage_ratio: float, max_delay_days: int) -> dict[str, Any]:
    source_id = str(source.get("source_id") or "unknown")
    source_kind = str(source.get("source_kind") or "unknown")
    provided_fields = _clean_set(source.get("provided_fields"))
    required_fields = _source_required_fields(source_kind)
    coverage_ratio = _as_float(source.get("coverage_ratio"), 0.0)
    delay_days = _as_int(source.get("max_delay_days"), 999)
    license_status = str(source.get("license_status") or "unknown")
    survivorship = str(source.get("survivorship_check") or "not_required")
    holiday_alignment = str(source.get("holiday_alignment") or "not_required")

    required_missing = sorted(required_fields - provided_fields)
    required_passed = not required_missing
    coverage_passed = coverage_ratio >= min_coverage_ratio
    delay_passed = delay_days <= max_delay_days
    license_passed = license_status in ALLOWED_LICENSE_STATUSES
    survivorship_passed = source_kind != "us_leading" or survivorship in {"passed", "not_required"}
    holiday_passed = source_kind != "world_index" or holiday_alignment in {"verified", "not_required"}

    checks = {
        "coverage": _check("coverage", coverage_passed, round(coverage_ratio, 4), min_coverage_ratio),
        "delay": _check("delay", delay_passed, delay_days, max_delay_days),
        "license": _check("license", license_passed, license_status, sorted(ALLOWED_LICENSE_STATUSES)),
        "required_fields": _check("required_fields", required_passed, sorted(provided_fields), sorted(required_fields)),
        "survivorship": _check("survivorship", survivorship_passed, survivorship),
        "holiday_alignment": _check("holiday_alignment", holiday_passed, holiday_alignment),
    }

    blocking_reasons: list[str] = []
    if not coverage_passed:
        blocking_reasons.append("coverage_below_threshold")
    if not delay_passed:
        blocking_reasons.append("delay_above_threshold")
    if not license_passed:
        blocking_reasons.append("license_not_allowed")
    if not required_passed:
        blocking_reasons.append("required_fields_missing")
    if not survivorship_passed:
        blocking_reasons.append("survivorship_check_failed")
    if not holiday_passed:
        blocking_reasons.append("holiday_alignment_missing")

    replacement_surface = _replacement_surface(source_kind, required_passed)
    all_common_gates_passed = coverage_passed and delay_passed and license_passed and required_passed

    if source_kind == "us_leading" and all_common_gates_passed and survivorship_passed:
        status = "replacement_candidate"
        allowed_use = "replace_current_us_leading"
    elif source_kind == "world_index" and all_common_gates_passed and holiday_passed:
        status = "augment_candidate"
        allowed_use = "augment_morning_setup"
    elif not blocking_reasons:
        status = "augment_candidate"
        allowed_use = "augment_morning_setup"
    else:
        status = "shadow_only"
        allowed_use = "shadow_context"

    return {
        "source_id": source_id,
        "source_kind": source_kind,
        "status": status,
        "allowed_use": allowed_use,
        "replacement_surface": replacement_surface,
        "provided_fields": sorted(provided_fields),
        "required_missing": required_missing,
        "blocking_reasons": blocking_reasons,
        "checks": checks,
    }


def build_global_context_readiness_report(
    catalog: dict[str, Any],
    *,
    observed_sources: list[dict[str, Any]],
    generated_at: str | None = None,
    min_coverage_ratio: float = 0.95,
    max_delay_days: int = 1,
) -> dict[str, Any]:
    evaluations = [
        _evaluate_source(source, min_coverage_ratio=min_coverage_ratio, max_delay_days=max_delay_days)
        for source in observed_sources
        if isinstance(source, dict)
    ]
    report = {
        "schema_version": GLOBAL_CONTEXT_READINESS_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "catalog_summary": _catalog_summary(catalog),
        "policy": {
            "replacement_gate": "coverage_delay_license_required_fields",
            "current_primary": "stockvision_worker_us_leading",
            "world_index_rule": "augment_morning_setup_only",
            "license_rule": "unknown_or_restricted_license_cannot_replace",
            "survivorship_rule": "us_leading_replacement_requires_survivorship_check",
        },
        "thresholds": {
            "min_coverage_ratio": min_coverage_ratio,
            "max_delay_days": max_delay_days,
        },
        "evaluations": evaluations,
    }
    report["selected_morning_context_source"] = select_morning_context_source(report)
    report["checksum"] = _sha256_json({
        "schema_version": report["schema_version"],
        "catalog_summary": report["catalog_summary"],
        "policy": report["policy"],
        "thresholds": report["thresholds"],
        "evaluations": report["evaluations"],
        "selected_morning_context_source": report["selected_morning_context_source"],
    })
    return report


def select_morning_context_source(report: dict[str, Any]) -> dict[str, Any]:
    evaluations = report.get("evaluations") if isinstance(report.get("evaluations"), list) else []
    for item in evaluations:
        if isinstance(item, dict) and item.get("status") == "replacement_candidate" and item.get("allowed_use") == "replace_current_us_leading":
            return {
                "source_id": item.get("source_id"),
                "mode": "replacement_candidate",
                "reason": "all_replacement_gates_passed",
            }
    augment = [
        item for item in evaluations
        if isinstance(item, dict) and item.get("status") == "augment_candidate"
    ]
    return {
        "source_id": "stockvision_worker_us_leading",
        "mode": "primary_with_finlab_augment" if augment else "primary",
        "reason": "no_finlab_us_leading_replacement_candidate",
        "augment_sources": [item.get("source_id") for item in augment],
    }


def validate_global_context_readiness_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema_version") != GLOBAL_CONTEXT_READINESS_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not report.get("checksum"):
        errors.append("checksum_missing")
    evaluations = report.get("evaluations")
    if not isinstance(evaluations, list):
        errors.append("evaluations_missing")
        return errors
    for item in evaluations:
        if not isinstance(item, dict):
            errors.append("evaluation_invalid")
            continue
        if item.get("allowed_use") == "replace_current_us_leading" and item.get("status") != "replacement_candidate":
            errors.append(f"{item.get('source_id')}:invalid_replacement_status")
        if item.get("allowed_use") == "replace_current_us_leading" and item.get("checks", {}).get("license", {}).get("passed") is not True:
            errors.append(f"{item.get('source_id')}:replacement_without_license")
        if item.get("source_kind") == "world_index" and item.get("allowed_use") == "replace_current_us_leading":
            errors.append(f"{item.get('source_id')}:world_index_cannot_replace_us_leading")
    return errors
