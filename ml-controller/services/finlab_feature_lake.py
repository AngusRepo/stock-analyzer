from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterable


FINLAB_FEATURE_LAKE_MANIFEST_SCHEMA_VERSION = "finlab-feature-lake-manifest-v1"

ROW_LEVEL_CHECKS = {
    "20_30_day_parity",
    "duplicate_rate",
    "missing_rate",
    "null_rate",
    "split_adjustment",
    "twse_tpex_diff_report",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _as_string_list(values: Iterable[Any]) -> list[str]:
    out: list[str] = []
    for value in values or []:
        text = str(value).strip()
        if text:
            out.append(text)
    return out


def _asset_key(parts: Iterable[Any]) -> str:
    return "/".join(_as_string_list(parts))


def build_canonical_feature_contract(
    feature_cols: Iterable[Any],
    *,
    schema_version: str = "v2",
    source_module: str = "ml-service.app.features.FEATURE_COLS",
) -> dict[str, Any]:
    features = _as_string_list(feature_cols)
    return {
        "schema_version": schema_version,
        "source_module": source_module,
        "feature_count": len(features),
        "features_hash": _sha256_json(features),
        "features": features,
        "production_mutation_allowed": False,
        "sidecar_policy": "do_not_append_unpromoted_finlab_sidecar_to_formal_feature_contract",
    }


def _adoption_asset_map(adoption_plan: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {
        (str(asset.get("stage")), str(asset.get("dataset_lane"))): asset
        for asset in adoption_plan.get("assets") or []
        if isinstance(asset, dict)
    }


def _checks_by_family(definitions_payload: dict[str, Any]) -> dict[tuple[str, str], dict[str, list[str]]]:
    out: dict[tuple[str, str], dict[str, list[str]]] = {}
    for check in definitions_payload.get("asset_checks") or []:
        asset_key = list(check.get("asset_key") or [])
        if len(asset_key) < 4:
            continue
        stage = str(asset_key[1])
        lane = str(asset_key[2])
        name = str(check.get("name") or "")
        if not name:
            continue
        bucket = out.setdefault((stage, lane), {"all": [], "row_level": [], "metadata_only": []})
        bucket["all"].append(name)
        if name in ROW_LEVEL_CHECKS:
            bucket["row_level"].append(name)
        else:
            bucket["metadata_only"].append(name)
    for bucket in out.values():
        for key in bucket:
            bucket[key] = sorted(set(bucket[key]))
    return out


def _promotion_state(stage: str) -> str:
    if stage == "parity":
        return "shadow_parity"
    if stage == "diversity":
        return "shadow_diversity"
    if stage == "research":
        return "research_only"
    return "rejected"


def _sidecar_family(
    asset: dict[str, Any],
    *,
    adoption_asset: dict[str, Any] | None,
    check_bucket: dict[str, list[str]] | None,
) -> dict[str, Any]:
    key = _asset_key(asset["key"])
    metadata = dict(asset.get("metadata") or {})
    stage = str(metadata.get("stage") or asset["key"][1])
    lane = str(metadata.get("dataset_lane") or asset["key"][2])
    is_emerging = lane.startswith("emerging_")
    checks = check_bucket or {"all": [], "row_level": [], "metadata_only": []}
    return {
        "asset_key": key,
        "stage": stage,
        "dataset_lane": lane,
        "feature_namespace": f"finlab_{stage}_{lane}",
        "output_table": "finlab_feature_lake_shadow",
        "join_keys": ["symbol", "date"],
        "write_mode": "append_only_shadow",
        "promotion_state": _promotion_state(stage),
        "field_count": int(metadata.get("field_count") or (adoption_asset or {}).get("field_count") or 0),
        "stockvision_use": metadata.get("stockvision_use") or (adoption_asset or {}).get("stockvision_use"),
        "quality_gates": list((adoption_asset or {}).get("quality_gates") or []),
        "all_checks": checks["all"],
        "row_level_checks": checks["row_level"],
        "metadata_only_checks": checks["metadata_only"],
        "eligible_for_ml_training": False,
        "eligible_for_screener": False,
        "eligible_for_regime": False,
        "eligible_for_pending_buy": False if is_emerging else False,
        "watchlist_only": bool(is_emerging or stage == "research"),
        "promotion_gate_required": True,
    }


def build_finlab_feature_lake_manifest(
    adoption_plan: dict[str, Any],
    definitions_payload: dict[str, Any],
    *,
    canonical_features: Iterable[Any],
    generated_at: str | None = None,
) -> dict[str, Any]:
    canonical_contract = build_canonical_feature_contract(canonical_features)
    adoption_assets = _adoption_asset_map(adoption_plan)
    checks = _checks_by_family(definitions_payload)

    feature_lake_assets = [
        asset
        for asset in definitions_payload.get("assets") or []
        if isinstance(asset, dict) and _asset_key(asset.get("key") or []).endswith("/feature_lake")
    ]
    families = [
        _sidecar_family(
            asset,
            adoption_asset=adoption_assets.get((
                str((asset.get("metadata") or {}).get("stage") or asset["key"][1]),
                str((asset.get("metadata") or {}).get("dataset_lane") or asset["key"][2]),
            )),
            check_bucket=checks.get((
                str((asset.get("metadata") or {}).get("stage") or asset["key"][1]),
                str((asset.get("metadata") or {}).get("dataset_lane") or asset["key"][2]),
            )),
        )
        for asset in feature_lake_assets
    ]
    counts_by_stage = dict(Counter(family["stage"] for family in families))
    manifest = {
        "schema_version": FINLAB_FEATURE_LAKE_MANIFEST_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "source_plan_checksum": adoption_plan.get("checksum"),
        "source_dagster_payload_checksum": definitions_payload.get("asset_graph_checksum"),
        "policy": {
            "production_ml_input": "formal137_governed_feature_contract",
            "sidecar_mode": "shadow_only",
            "promotion_default": "no_direct_production_use",
            "training_policy": "not_eligible_until_shadow_gates_pass",
            "screener_policy": "not_eligible_until_explicit_promotion",
            "emerging_stock_policy": "watchlist_only_no_pending_buy",
        },
        "canonical_feature_contract": canonical_contract,
        "summary": {
            "canonical_feature_count": canonical_contract["feature_count"],
            "sidecar_family_count": len(families),
            "sidecar_fields_total": sum(int(family.get("field_count") or 0) for family in families),
            "families_by_stage": counts_by_stage,
        },
        "sidecar_families": families,
    }
    manifest["checksum"] = _sha256_json({
        "schema_version": manifest["schema_version"],
        "source_plan_checksum": manifest["source_plan_checksum"],
        "source_dagster_payload_checksum": manifest["source_dagster_payload_checksum"],
        "canonical_feature_contract": canonical_contract,
        "sidecar_families": families,
    })
    return manifest


def validate_finlab_feature_lake_manifest(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema_version") != FINLAB_FEATURE_LAKE_MANIFEST_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not manifest.get("checksum"):
        errors.append("checksum_missing")
    canonical = manifest.get("canonical_feature_contract") or {}
    features = canonical.get("features")
    if not isinstance(features, list) or not features:
        errors.append("canonical_features_missing")
    elif canonical.get("feature_count") != len(features):
        errors.append("canonical_feature_count_mismatch")
    if canonical.get("production_mutation_allowed") is not False:
        errors.append("production_feature_mutation_allowed")
    if manifest.get("policy", {}).get("production_ml_input") != "formal137_governed_feature_contract":
        errors.append("production_ml_input_policy_invalid")

    families = manifest.get("sidecar_families")
    if not isinstance(families, list) or not families:
        errors.append("sidecar_families_missing")
        return sorted(set(errors))
    for family in families:
        if not isinstance(family, dict):
            errors.append("sidecar_family_invalid")
            continue
        asset_key = str(family.get("asset_key"))
        if family.get("eligible_for_ml_training") is not False:
            errors.append(f"ml_training_enabled_before_promotion:{asset_key}")
        if family.get("eligible_for_pending_buy") is not False:
            errors.append(f"pending_buy_enabled_before_promotion:{asset_key}")
        if str(family.get("dataset_lane", "")).startswith("emerging_"):
            if family.get("eligible_for_pending_buy") is not False:
                errors.append(f"emerging_pending_buy_enabled:{asset_key}")
            if family.get("watchlist_only") is not True:
                errors.append(f"emerging_watchlist_only_missing:{asset_key}")
        if not family.get("join_keys"):
            errors.append(f"join_keys_missing:{asset_key}")
    return sorted(set(errors))
