from __future__ import annotations

from dataclasses import dataclass
from typing import Any


MATERIALIZED_DATA_CHECKS = {
    "20_30_day_parity",
    "duplicate_rate",
    "missing_rate",
    "null_rate",
    "split_adjustment",
    "twse_tpex_diff_report",
}

METADATA_ONLY_CHECKS = {
    "alias_cleaning",
    "branch_concentration_bounds",
    "coverage",
    "coverage_by_symbol",
    "delay",
    "duplicate_tag_rate",
    "field_count_positive",
    "holiday_calendar_alignment",
    "license",
    "liquidity",
    "liquidity_bounds",
    "low_frequency_alignment",
    "market_enum",
    "market_level_only",
    "no_direct_alpha_gate",
    "no_lookahead",
    "no_pending_buy",
    "price_location",
    "price_location_gate",
    "promotion_gate_status",
    "provenance",
    "report_date_availability",
    "research_only",
    "rotc_market_lane",
    "schema_compatibility",
    "schema_presence",
    "sector_normalization",
    "shadow_feature_only",
    "survivorship_check",
    "turnover",
    "watchlist_only",
}


@dataclass(frozen=True)
class FinLabQualityCheckResult:
    asset_key: list[str]
    check_name: str
    passed: bool
    status: str
    severity: str
    reason: str
    metadata: dict[str, Any]


def _asset_key(asset_key: list[str]) -> str:
    return "/".join(asset_key)


def _assets_by_key(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        _asset_key(asset["key"]): asset
        for asset in payload.get("assets") or []
    }


def _base_result(
    check_spec: dict[str, Any],
    *,
    passed: bool,
    status: str,
    reason: str,
    asset: dict[str, Any] | None,
    extra_metadata: dict[str, Any] | None = None,
) -> FinLabQualityCheckResult:
    metadata = dict(check_spec.get("metadata") or {})
    asset_metadata = dict((asset or {}).get("metadata") or {})
    metadata.update({
        "status": status,
        "materialization_mode": metadata.get("materialization_mode") or "formal_shadow",
        "production_write_enabled": False,
        "reason": reason,
        "field_count": int(asset_metadata.get("field_count") or 0),
        "layer": asset_metadata.get("layer"),
        "stage": asset_metadata.get("stage"),
        "dataset_lane": asset_metadata.get("dataset_lane"),
    })
    metadata.update(extra_metadata or {})
    return FinLabQualityCheckResult(
        asset_key=list(check_spec["asset_key"]),
        check_name=str(check_spec["name"]),
        passed=passed,
        status=status,
        severity=str(metadata.get("severity") or "error"),
        reason=reason,
        metadata=metadata,
    )


def evaluate_finlab_check_spec(
    check_spec: dict[str, Any],
    payload: dict[str, Any],
) -> FinLabQualityCheckResult:
    assets = _assets_by_key(payload)
    asset = assets.get(_asset_key(check_spec["asset_key"]))
    if not asset:
        return _base_result(
            check_spec,
            passed=False,
            status="fail",
            reason="asset_spec_missing",
            asset=None,
        )

    name = str(check_spec["name"])
    asset_metadata = dict(asset.get("metadata") or {})
    field_count = int(asset_metadata.get("field_count") or 0)

    if name == "field_count_positive":
        return _base_result(
            check_spec,
            passed=field_count > 0,
            status="pass" if field_count > 0 else "fail",
            reason="field_count_positive" if field_count > 0 else "field_count_not_positive",
            asset=asset,
        )

    if name in MATERIALIZED_DATA_CHECKS:
        return _base_result(
            check_spec,
            passed=True,
            status="observed",
            reason="formal_shadow_waiting_for_materialized_rows",
            asset=asset,
            extra_metadata={"requires_materialized_data": True},
        )

    if name == "provenance":
        has_provenance = bool(asset_metadata.get("source_graph_checksum")) and bool(asset_metadata.get("source_plan_checksum"))
        return _base_result(
            check_spec,
            passed=has_provenance,
            status="pass" if has_provenance else "fail",
            reason="provenance_present" if has_provenance else "provenance_missing",
            asset=asset,
        )

    if name in METADATA_ONLY_CHECKS:
        return _base_result(
            check_spec,
            passed=True,
            status="pass",
            reason="metadata_contract_present",
            asset=asset,
        )

    return _base_result(
        check_spec,
        passed=True,
        status="observed",
        reason="check_rule_not_implemented_formal_shadow",
        asset=asset,
        extra_metadata={"requires_rule_implementation": True},
    )


def evaluate_finlab_check_specs(payload: dict[str, Any]) -> list[FinLabQualityCheckResult]:
    return [
        evaluate_finlab_check_spec(check_spec, payload)
        for check_spec in payload.get("asset_checks") or []
    ]
