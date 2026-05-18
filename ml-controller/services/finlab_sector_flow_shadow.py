from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterable


FINLAB_SECTOR_FLOW_SHADOW_SCHEMA_VERSION = "finlab-sector-flow-shadow-manifest-v1"

LAYER_CONTRACTS = [
    {
        "tag_type": "industry",
        "classification": "industry",
        "label_level": "formal_industry",
        "source_kind": "finlab",
        "source_dataset": "security_categories",
        "source_fields": ["category", "market"],
        "role": "formal listed/otc/emerging industry grouping",
    },
    {
        "tag_type": "industry_theme",
        "classification": "industry_theme",
        "label_level": "industry_theme",
        "source_kind": "finlab",
        "source_dataset": "security_industry_themes",
        "source_fields": ["category", "name"],
        "role": "FinLab thematic industry taxonomy",
    },
    {
        "tag_type": "subindustry",
        "classification": "subindustry",
        "label_level": "subindustry",
        "source_kind": "finlab",
        "source_dataset": "security_industry_themes",
        "source_fields": ["name", "category"],
        "role": "finer taxonomy below formal industry/theme",
    },
    {
        "tag_type": "concept",
        "classification": "theme",
        "label_level": "market_concept",
        "source_kind": "local_overlay",
        "source_dataset": "concept_stock_mapping.json",
        "source_fields": ["concept", "symbol"],
        "role": "local market-topic overlay and event-driven concept tags",
    },
]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _as_text(value: Any) -> str:
    return str(value or "").strip()


def _find_family(feature_lake_manifest: dict[str, Any], lane: str) -> dict[str, Any] | None:
    for family in feature_lake_manifest.get("sidecar_families") or []:
        if isinstance(family, dict) and family.get("dataset_lane") == lane:
            return family
    return None


def build_finlab_sector_flow_shadow_manifest(
    feature_lake_manifest: dict[str, Any],
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    taxonomy_family = _find_family(feature_lake_manifest, "taxonomy_expansion") or {}
    chip_family = _find_family(feature_lake_manifest, "chip_diversity") or {}
    layers = [dict(layer) for layer in LAYER_CONTRACTS]
    manifest = {
        "schema_version": FINLAB_SECTOR_FLOW_SHADOW_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "source_feature_lake_checksum": feature_lake_manifest.get("checksum"),
        "policy": {
            "mode": "shadow_only",
            "production_write_enabled": False,
            "cross_layer_rollup_allowed": False,
            "isolation_key": ["date", "sector", "classification"],
            "dedupe_key": ["symbol", "tag_type", "tag"],
            "cash_flow_source": "chip_data_5d_or_finlab_chip_diversity_shadow",
            "promotion_default": "no_direct_screener_or_ml_use",
        },
        "taxonomy_source": {
            "asset_key": taxonomy_family.get("asset_key"),
            "feature_namespace": taxonomy_family.get("feature_namespace"),
            "field_count": int(taxonomy_family.get("field_count") or 0),
            "metadata_only_checks": list(taxonomy_family.get("metadata_only_checks") or []),
            "row_level_checks": list(taxonomy_family.get("row_level_checks") or []),
        },
        "cash_flow_source": {
            "asset_key": chip_family.get("asset_key"),
            "feature_namespace": chip_family.get("feature_namespace"),
            "field_count": int(chip_family.get("field_count") or 0),
            "row_level_checks": list(chip_family.get("row_level_checks") or []),
        },
        "layers": layers,
        "summary": {
            "layer_count": len(layers),
            "taxonomy_sidecar_fields": int(taxonomy_family.get("field_count") or 0),
            "chip_sidecar_fields": int(chip_family.get("field_count") or 0),
        },
    }
    manifest["checksum"] = _sha256_json({
        "schema_version": manifest["schema_version"],
        "source_feature_lake_checksum": manifest["source_feature_lake_checksum"],
        "policy": manifest["policy"],
        "taxonomy_source": manifest["taxonomy_source"],
        "cash_flow_source": manifest["cash_flow_source"],
        "layers": manifest["layers"],
    })
    return manifest


def normalize_sector_flow_memberships(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    memberships: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    duplicates = 0
    symbols_by_tag: dict[tuple[str, str], set[str]] = {}

    for row in rows:
        symbol = _as_text(row.get("symbol"))
        tag_type = _as_text(row.get("tag_type"))
        tag = _as_text(row.get("tag"))
        if not symbol or not tag_type or not tag:
            continue
        key = (symbol, tag_type, tag)
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        membership = {
            "symbol": symbol,
            "tag_type": tag_type,
            "tag": tag,
            "source": _as_text(row.get("source")) or "unknown",
        }
        memberships.append(membership)
        symbols_by_tag.setdefault((tag_type, tag), set()).add(symbol)

    tag_text_by_symbol: dict[str, set[str]] = {}
    layer_text_by_symbol: dict[str, set[str]] = {}
    for row in memberships:
        tag_text_by_symbol.setdefault(row["symbol"], set()).add(row["tag"])
        layer_text_by_symbol.setdefault(row["symbol"], set()).add(f"{row['tag_type']}::{row['tag']}")
    cross_layer_preserved = any(
        len(tags) < len(layer_text_by_symbol.get(symbol, set()))
        for symbol, tags in tag_text_by_symbol.items()
    )
    return {
        "memberships": memberships,
        "duplicate_rows_dropped": duplicates,
        "cross_layer_memberships_preserved": cross_layer_preserved,
        "summary": {
            "membership_count": len(memberships),
            "symbols_by_layer": dict(Counter(row["tag_type"] for row in memberships)),
            "tag_count": len(symbols_by_tag),
        },
    }


def validate_finlab_sector_flow_shadow_manifest(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema_version") != FINLAB_SECTOR_FLOW_SHADOW_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not manifest.get("checksum"):
        errors.append("checksum_missing")
    policy = manifest.get("policy") or {}
    if policy.get("mode") != "shadow_only":
        errors.append("mode_not_shadow_only")
    if policy.get("production_write_enabled") is not False:
        errors.append("production_write_enabled")
    if policy.get("cross_layer_rollup_allowed") is not False:
        errors.append("cross_layer_rollup_allowed")
    if policy.get("isolation_key") != ["date", "sector", "classification"]:
        errors.append("isolation_key_invalid")

    layers = manifest.get("layers")
    if not isinstance(layers, list) or not layers:
        errors.append("layers_missing")
        return sorted(set(errors))
    required = {layer["tag_type"] for layer in LAYER_CONTRACTS}
    present = {str(layer.get("tag_type")) for layer in layers if isinstance(layer, dict)}
    for missing in sorted(required - present):
        errors.append(f"layer_missing:{missing}")

    classification_counts = Counter(
        str(layer.get("classification"))
        for layer in layers
        if isinstance(layer, dict) and layer.get("classification")
    )
    for classification, count in classification_counts.items():
        if count > 1:
            errors.append(f"classification_not_unique:{classification}")
    return sorted(set(errors))
