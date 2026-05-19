from __future__ import annotations

import importlib
from typing import Any

from services.finlab_dagster_checks import build_finlab_dagster_check_defs
from services.finlab_dagster_assets import validate_finlab_asset_graph


FINLAB_DAGSTER_DEFINITIONS_PAYLOAD_SCHEMA_VERSION = "finlab-dagster-definitions-payload-v1"


class FinLabDagsterFactoryError(RuntimeError):
    pass


def _asset_key_path(asset_key: str) -> list[str]:
    return [part for part in str(asset_key).split("/") if part]


def _validate_graph_or_raise(graph: dict[str, Any]) -> None:
    errors = validate_finlab_asset_graph(graph)
    if errors:
        raise FinLabDagsterFactoryError("invalid_finlab_asset_graph:" + ",".join(errors))


def _asset_spec(node: dict[str, Any], graph: dict[str, Any]) -> dict[str, Any]:
    return {
        "key": _asset_key_path(str(node["asset_key"])),
        "deps": [_asset_key_path(dep) for dep in node.get("deps") or []],
        "group_name": node.get("group_name") or "finlab_v4",
        "metadata": {
            "materialization_mode": "formal_shadow",
            "production_write_enabled": False,
            "compute_kind": "external_finlab_sdk",
            "materialization_owner": "stockvision_data_platform",
            "owner": node.get("owner"),
            "source": node.get("source"),
            "schema": node.get("schema"),
            "freshness": node.get("freshness"),
            "join_key": node.get("join_key"),
            "output_location": node.get("output_location"),
            "layer": node.get("layer"),
            "stage": node.get("stage"),
            "dataset_lane": node.get("dataset_lane"),
            "access_tier": node.get("access_tier"),
            "field_count": int(node.get("field_count") or 0),
            "markets": list(node.get("markets") or []),
            "namespaces": list(node.get("namespaces") or []),
            "stockvision_use": node.get("stockvision_use"),
            "source_asset_key": node.get("source_asset_key"),
            "source_graph_checksum": graph.get("checksum"),
            "source_plan_checksum": graph.get("source_plan_checksum"),
        },
    }


def _check_spec(check: dict[str, Any], graph: dict[str, Any]) -> dict[str, Any]:
    name = str(check["check_name"])
    asset_key = str(check["asset_key"])
    return {
        "name": name,
        "asset_key": _asset_key_path(asset_key),
        "description": f"FinLab V4 quality check: {name}",
        "metadata": {
            "materialization_mode": "formal_shadow",
            "production_write_enabled": False,
            "severity": check.get("severity") or "error",
            "source_asset_key": asset_key,
            "source_graph_checksum": graph.get("checksum"),
            "source_plan_checksum": graph.get("source_plan_checksum"),
        },
    }


def build_finlab_spec_payload(graph: dict[str, Any]) -> dict[str, Any]:
    _validate_graph_or_raise(graph)
    return {
        "schema_version": FINLAB_DAGSTER_DEFINITIONS_PAYLOAD_SCHEMA_VERSION,
        "mode": "asset_runtime_formal_shadow",
        "asset_graph_checksum": graph.get("checksum"),
        "source_plan_checksum": graph.get("source_plan_checksum"),
        "generated_from": graph.get("schema_version"),
        "assets": [_asset_spec(node, graph) for node in graph.get("nodes") or []],
        "asset_checks": [_check_spec(check, graph) for check in graph.get("checks") or []],
    }


def _dagster_available() -> bool:
    try:
        importlib.import_module("dagster")
    except ImportError:
        return False
    return True


def build_finlab_definitions_payload(graph: dict[str, Any]) -> dict[str, Any]:
    payload = build_finlab_spec_payload(graph)
    payload["dagster_available"] = _dagster_available()
    payload["schedules"] = [
        {
            "name": "finlab_v4_shadow_refresh",
            "cron": "30 18 * * 1-5",
            "timezone": "Asia/Taipei",
            "enabled": False,
            "reason": "formal_shadow_requires_cpd_enablement",
            "targets": ["finlab"],
        }
    ]
    return payload


def build_finlab_dagster_definitions(graph: dict[str, Any]) -> Any:
    payload = build_finlab_spec_payload(graph)
    try:
        dagster = importlib.import_module("dagster")
    except ImportError as exc:
        raise FinLabDagsterFactoryError("dagster_not_installed") from exc

    asset_specs = [
        dagster.AssetSpec(
            key=dagster.AssetKey(spec["key"]),
            deps=[dagster.AssetKey(dep) for dep in spec["deps"]],
            group_name=spec["group_name"],
            metadata=spec["metadata"],
        )
        for spec in payload["assets"]
    ]
    if hasattr(dagster, "external_assets_from_specs"):
        external_assets = dagster.external_assets_from_specs(asset_specs)
        asset_checks = build_finlab_dagster_check_defs(payload, dagster_module=dagster)
        return dagster.Definitions(assets=list(external_assets), asset_checks=asset_checks, schedules=[])

    asset_checks = build_finlab_dagster_check_defs(payload, dagster_module=dagster)
    return dagster.Definitions(assets=asset_specs, asset_checks=asset_checks)
