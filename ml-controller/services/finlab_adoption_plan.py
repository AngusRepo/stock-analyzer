from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


FINLAB_ADOPTION_PLAN_SCHEMA_VERSION = "finlab-adoption-plan-v1"

LANE_STAGE_BY_MODE = {
    "replace": "parity",
    "augment": "diversity",
    "benchmark": "research",
    "reject": "rejected",
}

LANE_ASSET_USE = {
    "security_master": "primary security master, market lane, tradability route",
    "taxonomy_expansion": "industry_theme/subindustry labels and sector-flow taxonomy",
    "daily_price": "daily price parity against TWSE/TPEX and adjusted OHLCV feature base",
    "revenue": "monthly revenue parity and revenue momentum feature base",
    "fundamental_factor_diversity": "quality, value, growth, profitability and balance-sheet factors",
    "chip_diversity": "institutional flow, margin/lending and broker concentration shadow features",
    "emerging_price_diversity": "emerging-stock price, liquidity and spread watchlist context",
    "emerging_revenue_diversity": "emerging-stock revenue momentum watchlist context",
    "emerging_chip_diversity": "emerging-stock broker flow evidence and concentration checks",
    "global_context": "US leading, world index, morning setup and regime context",
    "regime_context": "derivatives, macro, hedge pressure and low-frequency regime evidence",
    "research": "non-core global datasets and benchmark-only research candidates",
}

LANE_ACCESS_TIER = {
    "parity": "compute",
    "diversity": "compute",
    "research": "archive",
    "rejected": "archive",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _unique_sorted(values: Iterable[Any]) -> list[str]:
    return sorted({str(value) for value in values if value is not None and str(value) != ""})


def load_finlab_catalog(path: str | Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    if not isinstance(payload, dict) or not isinstance(payload.get("fields"), list):
        raise ValueError("finlab_catalog_invalid:fields_missing")
    return payload


def build_finlab_adoption_plan(
    catalog: dict[str, Any],
    *,
    generated_at: str | None = None,
    producer_run_id: str = "manual",
) -> dict[str, Any]:
    fields = [field for field in catalog.get("fields", []) if isinstance(field, dict)]
    by_lane_stage: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)

    for field in fields:
        mode = str(field.get("adoption_mode") or "benchmark")
        lane = str(field.get("dataset_lane") or "research")
        if bool(field.get("replaces_twse_tpex_primary")):
            by_lane_stage[("parity", lane)].append(field)
        stage = LANE_STAGE_BY_MODE.get(mode, "research")
        if stage == "parity":
            if not bool(field.get("replaces_twse_tpex_primary")):
                by_lane_stage[("research", lane)].append(field)
        else:
            by_lane_stage[(stage, lane)].append(field)

    assets: list[dict[str, Any]] = []
    for (stage, lane), lane_fields in sorted(by_lane_stage.items()):
        asset = {
            "asset_key": f"finlab/{stage}/{lane}",
            "stage": stage,
            "dataset_lane": lane,
            "access_tier": LANE_ACCESS_TIER.get(stage, "compute"),
            "field_count": len(lane_fields),
            "markets": _unique_sorted(field.get("market") for field in lane_fields),
            "namespaces": _unique_sorted(field.get("namespace") for field in lane_fields),
            "adoption_priorities": _unique_sorted(field.get("adoption_priority") for field in lane_fields),
            "adoption_modes": _unique_sorted(field.get("adoption_mode") for field in lane_fields),
            "quality_gates": _unique_sorted(field.get("quality_gate") for field in lane_fields),
            "stockvision_use": LANE_ASSET_USE.get(lane, "shadow feature candidate"),
            "sample_api_keys": [str(field.get("api_key")) for field in lane_fields[:12]],
        }
        asset["checksum"] = _sha256_json(asset)
        assets.append(asset)

    counts = {
        "field_count": len(fields),
        "asset_count": len(assets),
        "by_stage": dict(Counter(asset["stage"] for asset in assets)),
        "fields_by_stage": dict(Counter(
            stage for (stage, _lane), lane_fields in by_lane_stage.items() for _ in lane_fields
        )),
        "fields_by_dataset_lane": dict(Counter(str(field.get("dataset_lane") or "research") for field in fields)),
        "fields_by_adoption_mode": dict(Counter(str(field.get("adoption_mode") or "benchmark") for field in fields)),
    }

    plan = {
        "schema_version": FINLAB_ADOPTION_PLAN_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "producer_run_id": producer_run_id,
        "source_catalog": {
            "generated_at": catalog.get("generated_at"),
            "finlab_sdk_version": catalog.get("finlab_sdk_version"),
            "all_market_search_count": catalog.get("all_market_search_count"),
            "field_count": catalog.get("field_count"),
        },
        "policy": {
            "production_contract": "current_106_features_remain_stable",
            "parity_lane": "verify FinLab replacement against current TWSE/TPEX or existing StockVision fields",
            "diversity_lane": "ingest useful FinLab-native datasets in shadow feature lake even without old equivalents",
            "research_lane": "benchmark-only until explicit promotion gates pass",
            "emerging_stock_rule": "watchlist_only; eligible_for_pending_buy=false",
            "taxonomy_layers": ["industry", "industry_theme", "subindustry", "concept"],
        },
        "counts": counts,
        "assets": assets,
    }
    plan["checksum"] = _sha256_json({
        "schema_version": plan["schema_version"],
        "source_catalog": plan["source_catalog"],
        "counts": plan["counts"],
        "assets": plan["assets"],
    })
    return plan


def validate_finlab_adoption_plan(plan: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if plan.get("schema_version") != FINLAB_ADOPTION_PLAN_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not plan.get("checksum"):
        errors.append("checksum_missing")
    assets = plan.get("assets")
    if not isinstance(assets, list) or not assets:
        errors.append("assets_missing")
        return errors

    required_lanes = {
        "security_master",
        "taxonomy_expansion",
        "daily_price",
        "revenue",
        "chip_diversity",
        "emerging_chip_diversity",
        "global_context",
    }
    present_lanes = {str(asset.get("dataset_lane")) for asset in assets if isinstance(asset, dict)}
    missing_lanes = sorted(required_lanes - present_lanes)
    if missing_lanes:
        errors.append("required_lanes_missing:" + ",".join(missing_lanes))

    for asset in assets:
        if not isinstance(asset, dict):
            errors.append("asset_invalid")
            continue
        for key in ("asset_key", "stage", "dataset_lane", "access_tier", "field_count", "quality_gates"):
            if key not in asset:
                errors.append(f"asset_{key}_missing")
        try:
            if int(asset.get("field_count", 0)) <= 0:
                errors.append(f"asset_field_count_invalid:{asset.get('asset_key')}")
        except (TypeError, ValueError):
            errors.append(f"asset_field_count_invalid:{asset.get('asset_key')}")
    return errors
