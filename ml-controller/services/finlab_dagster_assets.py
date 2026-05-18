from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable


FINLAB_DAGSTER_ASSET_GRAPH_SCHEMA_VERSION = "finlab-dagster-asset-graph-v1"

STANDARD_CHECKS_BY_LAYER = {
    "raw": ("freshness", "schema_presence", "field_count_positive"),
    "clean": ("schema_compatibility", "null_rate", "duplicate_rate"),
    "feature_lake": ("provenance", "promotion_gate_status"),
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _split_quality_gates(gates: Iterable[Any]) -> list[str]:
    names: set[str] = set()
    for gate in gates:
        for part in str(gate or "").split(","):
            name = part.strip().lower().replace("-", "_").replace(" ", "_")
            if name:
                names.add(name)
    return sorted(names)


def _node(
    *,
    source_asset: dict[str, Any],
    layer: str,
    deps: list[str],
) -> dict[str, Any]:
    stage = str(source_asset["stage"])
    lane = str(source_asset["dataset_lane"])
    asset_key = f"finlab/{stage}/{lane}/{layer}"
    join_key = ["stock_id", "date"]
    if lane == "security_master":
        join_key = ["stock_id"]
    elif lane == "revenue":
        join_key = ["stock_id", "revenue_month"]
    elif lane in {"taxonomy_expansion", "global_context", "regime_context", "research"}:
        join_key = ["as_of_date", "dataset"]
    return {
        "asset_key": asset_key,
        "layer": layer,
        "deps": deps,
        "group_name": f"finlab_v4_{stage}",
        "owner": "stockvision_data_platform",
        "source": "finlab",
        "schema": {
            "schema_ref": f"finlab.{lane}.{layer}",
            "field_count": int(source_asset.get("field_count") or 0),
            "namespaces": list(source_asset.get("namespaces") or []),
        },
        "freshness": {
            "policy": "trading_day_after_close",
            "timezone": "Asia/Taipei",
            "max_lag_hours": 30,
        },
        "join_key": join_key,
        "output_location": f"gcs://stockvision-models/finlab_v4/{stage}/{lane}/{layer}/",
        "stage": stage,
        "dataset_lane": lane,
        "access_tier": source_asset.get("access_tier"),
        "field_count": int(source_asset.get("field_count") or 0),
        "markets": list(source_asset.get("markets") or []),
        "namespaces": list(source_asset.get("namespaces") or []),
        "stockvision_use": source_asset.get("stockvision_use"),
        "source_asset_key": source_asset.get("asset_key"),
        "source_checksum": source_asset.get("checksum"),
    }


def _check(asset_key: str, check_name: str, *, severity: str = "error") -> dict[str, Any]:
    return {
        "asset_key": asset_key,
        "check_name": check_name,
        "severity": severity,
    }


def _checks_for_asset(source_asset: dict[str, Any]) -> list[dict[str, Any]]:
    stage = str(source_asset["stage"])
    lane = str(source_asset["dataset_lane"])
    base = f"finlab/{stage}/{lane}"

    checks: list[dict[str, Any]] = []
    for layer, names in STANDARD_CHECKS_BY_LAYER.items():
        for name in names:
            checks.append(_check(f"{base}/{layer}", name))

    for name in _split_quality_gates(source_asset.get("quality_gates") or []):
        checks.append(_check(f"{base}/clean", name))

    if lane.startswith("emerging_"):
        checks.append(_check(f"{base}/feature_lake", "no_pending_buy", severity="error"))
        checks.append(_check(f"{base}/feature_lake", "watchlist_only", severity="error"))
    if stage == "research":
        checks.append(_check(f"{base}/feature_lake", "research_only", severity="warn"))
    if stage == "parity":
        checks.append(_check(f"{base}/feature_lake", "twse_tpex_diff_report", severity="error"))
    if stage == "diversity":
        checks.append(_check(f"{base}/feature_lake", "shadow_feature_only", severity="error"))

    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, Any]] = []
    for check in checks:
        key = (check["asset_key"], check["check_name"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(check)
    return deduped


def build_finlab_asset_graph(
    adoption_plan: dict[str, Any],
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []

    for source_asset in adoption_plan.get("assets") or []:
        stage = str(source_asset["stage"])
        lane = str(source_asset["dataset_lane"])
        raw_key = f"finlab/{stage}/{lane}/raw"
        clean_key = f"finlab/{stage}/{lane}/clean"

        nodes.extend([
            _node(source_asset=source_asset, layer="raw", deps=[]),
            _node(source_asset=source_asset, layer="clean", deps=[raw_key]),
            _node(source_asset=source_asset, layer="feature_lake", deps=[clean_key]),
        ])
        checks.extend(_checks_for_asset(source_asset))

    formal_assets = [
        "security_master",
        "daily_price",
        "chip_flow",
        "broker_flow",
        "rotc_price",
        "rotc_broker_transactions",
        "taxonomy",
        "macro",
        "world_index",
        "feature_lake",
    ]
    graph = {
        "schema_version": FINLAB_DAGSTER_ASSET_GRAPH_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "source_plan_checksum": adoption_plan.get("checksum"),
        "source_plan_schema_version": adoption_plan.get("schema_version"),
        "policy": {
            "dagster_role": "orchestration_only",
            "langgraph_role": "reasoning_and_decision_flow",
            "production_contract": "current_106_features_remain_stable",
            "finlab_data_role": "parity_and_diversity_feature_lake_shadow_before_promotion",
        },
        "summary": {
            "source_asset_count": len(adoption_plan.get("assets") or []),
            "node_count": len(nodes),
            "check_count": len(checks),
            "formal_asset_count": len(formal_assets),
        },
        "formal_assets": formal_assets,
        "nodes": nodes,
        "checks": checks,
    }
    graph["checksum"] = _sha256_json({
        "schema_version": graph["schema_version"],
        "source_plan_checksum": graph["source_plan_checksum"],
        "nodes": nodes,
        "checks": checks,
    })
    return graph


def validate_finlab_asset_graph(graph: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if graph.get("schema_version") != FINLAB_DAGSTER_ASSET_GRAPH_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not graph.get("source_plan_checksum"):
        errors.append("source_plan_checksum_missing")
    if not graph.get("checksum"):
        errors.append("checksum_missing")

    nodes = graph.get("nodes")
    checks = graph.get("checks")
    if not isinstance(nodes, list) or not nodes:
        errors.append("nodes_missing")
        return errors
    if not isinstance(checks, list) or not checks:
        errors.append("checks_missing")

    node_keys = {node.get("asset_key") for node in nodes if isinstance(node, dict)}
    if not any(str(key).endswith("/raw") for key in node_keys):
        errors.append("raw_nodes_missing")
    if not any(str(key).endswith("/clean") for key in node_keys):
        errors.append("clean_nodes_missing")
    if not any(str(key).endswith("/feature_lake") for key in node_keys):
        errors.append("feature_lake_nodes_missing")

    for node in nodes:
        if not isinstance(node, dict):
            errors.append("node_invalid")
            continue
        for dep in node.get("deps") or []:
            if dep not in node_keys:
                errors.append(f"dependency_missing:{node.get('asset_key')}->{dep}")
        if int(node.get("field_count") or 0) <= 0:
            errors.append(f"field_count_invalid:{node.get('asset_key')}")
        for field in ("owner", "source", "schema", "freshness", "join_key", "output_location"):
            if not node.get(field):
                errors.append(f"{field}_missing:{node.get('asset_key')}")

    return sorted(set(errors))
