from __future__ import annotations

import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_dagster_factory import (  # noqa: E402
    build_finlab_dagster_definitions,
    build_finlab_definitions_payload,
    build_finlab_spec_payload,
)


def _graph() -> dict:
    graph = {
        "schema_version": "finlab-dagster-asset-graph-v1",
        "generated_at": "2026-05-16T00:00:00+00:00",
        "checksum": "sha256:graph",
        "source_plan_checksum": "sha256:plan",
        "nodes": [
            {
                "asset_key": "finlab/parity/daily_price/raw",
                "layer": "raw",
                "deps": [],
                "group_name": "finlab_v4_parity",
                "stage": "parity",
                "dataset_lane": "daily_price",
                "field_count": 3,
                "markets": ["tw"],
                "namespaces": ["price"],
                "stockvision_use": "daily price parity",
            },
            {
                "asset_key": "finlab/parity/daily_price/clean",
                "layer": "clean",
                "deps": ["finlab/parity/daily_price/raw"],
                "group_name": "finlab_v4_parity",
                "stage": "parity",
                "dataset_lane": "daily_price",
                "field_count": 3,
                "markets": ["tw"],
                "namespaces": ["price"],
                "stockvision_use": "daily price parity",
            },
            {
                "asset_key": "finlab/parity/daily_price/feature_lake",
                "layer": "feature_lake",
                "deps": ["finlab/parity/daily_price/clean"],
                "group_name": "finlab_v4_parity",
                "stage": "parity",
                "dataset_lane": "daily_price",
                "field_count": 3,
                "markets": ["tw"],
                "namespaces": ["price"],
                "stockvision_use": "daily price parity",
            },
        ],
        "checks": [
            {
                "asset_key": "finlab/parity/daily_price/raw",
                "check_name": "freshness",
                "severity": "error",
            },
            {
                "asset_key": "finlab/parity/daily_price/clean",
                "check_name": "missing_rate",
                "severity": "error",
            },
            {
                "asset_key": "finlab/parity/daily_price/feature_lake",
                "check_name": "twse_tpex_diff_report",
                "severity": "error",
            },
        ],
    }
    for node in graph["nodes"]:
        node.update({
            "owner": "stockvision_data_platform",
            "source": "finlab",
            "schema": {"schema_ref": "finlab.daily_price", "field_count": 3},
            "freshness": {"policy": "trading_day_after_close", "max_lag_hours": 30},
            "join_key": ["stock_id", "date"],
            "output_location": "gcs://stockvision-models/finlab_v4/parity/daily_price/",
        })
    return graph


def test_spec_payload_keeps_finlab_assets_as_formal_shadow_runtime():
    payload = build_finlab_spec_payload(_graph())

    raw_spec = payload["assets"][0]
    clean_spec = payload["assets"][1]

    assert payload["schema_version"] == "finlab-dagster-definitions-payload-v1"
    assert payload["mode"] == "asset_runtime_formal_shadow"
    assert raw_spec["key"] == ["finlab", "parity", "daily_price", "raw"]
    assert raw_spec["deps"] == []
    assert raw_spec["group_name"] == "finlab_v4_parity"
    assert raw_spec["metadata"]["materialization_mode"] == "formal_shadow"
    assert raw_spec["metadata"]["production_write_enabled"] is False
    assert raw_spec["metadata"]["compute_kind"] == "external_finlab_sdk"
    assert raw_spec["metadata"]["materialization_owner"] == "stockvision_data_platform"
    assert "compute_fn" not in raw_spec
    assert clean_spec["deps"] == [["finlab", "parity", "daily_price", "raw"]]


def test_definitions_payload_exposes_checks_and_disabled_schedule_contract():
    payload = build_finlab_definitions_payload(_graph())

    check_names = {check["name"] for check in payload["asset_checks"]}
    schedule = payload["schedules"][0]

    assert payload["asset_graph_checksum"] == "sha256:graph"
    assert "freshness" in check_names
    assert "missing_rate" in check_names
    assert "twse_tpex_diff_report" in check_names
    assert schedule["name"] == "finlab_v4_shadow_refresh"
    assert schedule["enabled"] is False
    assert schedule["reason"] == "formal_shadow_requires_cpd_enablement"


def test_build_finlab_dagster_definitions_uses_optional_runtime(monkeypatch):
    fake_dagster = types.ModuleType("dagster")

    class FakeAssetKey:
        def __init__(self, path):
            self.path = tuple(path)

    class FakeAssetSpec:
        def __init__(self, *, key, deps, group_name, metadata):
            self.key = key
            self.deps = deps
            self.group_name = group_name
            self.metadata = metadata

    class FakeAssetCheckSpec:
        def __init__(self, *, name, asset, description=None, metadata=None):
            self.name = name
            self.asset = asset
            self.description = description
            self.metadata = metadata

    class FakeAssetCheckResult:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeAssetCheckSeverity:
        ERROR = "ERROR"
        WARN = "WARN"

    class FakeDefinitions:
        def __init__(self, *, assets, asset_checks):
            self.assets = assets
            self.asset_checks = asset_checks

    def fake_multi_asset_check(*, specs, name):
        def decorator(fn):
            fn._dagster_specs = specs
            fn._dagster_name = name
            return fn

        return decorator

    fake_dagster.AssetKey = FakeAssetKey
    fake_dagster.AssetSpec = FakeAssetSpec
    fake_dagster.AssetCheckSpec = FakeAssetCheckSpec
    fake_dagster.AssetCheckResult = FakeAssetCheckResult
    fake_dagster.AssetCheckSeverity = FakeAssetCheckSeverity
    fake_dagster.Definitions = FakeDefinitions
    fake_dagster.multi_asset_check = fake_multi_asset_check
    monkeypatch.setitem(sys.modules, "dagster", fake_dagster)

    definitions = build_finlab_dagster_definitions(_graph())

    assert len(definitions.assets) == 3
    assert len(definitions.asset_checks) == 1
    assert definitions.assets[1].deps[0].path == ("finlab", "parity", "daily_price", "raw")
    assert len(definitions.asset_checks[0]._dagster_specs) == 3
    assert definitions.asset_checks[0]._dagster_specs[0].asset.path == ("finlab", "parity", "daily_price", "raw")


def test_build_finlab_dagster_definitions_uses_external_assets_when_available(monkeypatch):
    fake_dagster = types.ModuleType("dagster")
    captured_specs = []

    class FakeAssetKey:
        def __init__(self, path):
            self.path = tuple(path)

    class FakeAssetSpec:
        def __init__(self, *, key, deps, group_name, metadata):
            self.key = key
            self.deps = deps
            self.group_name = group_name
            self.metadata = metadata

    class FakeExternalAsset:
        def __init__(self, spec):
            self.spec = spec

    class FakeAssetCheckSpec:
        def __init__(self, *, name, asset):
            self.name = name
            self.asset = asset

    class FakeAssetCheckResult:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeAssetCheckSeverity:
        ERROR = "ERROR"
        WARN = "WARN"

    class FakeDefinitions:
        def __init__(self, *, assets, asset_checks=None, schedules=None):
            self.assets = assets
            self.asset_checks = asset_checks or []
            self.schedules = schedules or []

    def fake_external_assets_from_specs(specs):
        captured_specs.extend(specs)
        return [FakeExternalAsset(spec) for spec in specs]

    def fake_multi_asset_check(*, specs, name):
        def decorator(fn):
            fn._dagster_specs = specs
            fn._dagster_name = name
            return fn

        return decorator

    fake_dagster.AssetKey = FakeAssetKey
    fake_dagster.AssetSpec = FakeAssetSpec
    fake_dagster.AssetCheckSpec = FakeAssetCheckSpec
    fake_dagster.AssetCheckResult = FakeAssetCheckResult
    fake_dagster.AssetCheckSeverity = FakeAssetCheckSeverity
    fake_dagster.Definitions = FakeDefinitions
    fake_dagster.external_assets_from_specs = fake_external_assets_from_specs
    fake_dagster.multi_asset_check = fake_multi_asset_check
    monkeypatch.setitem(sys.modules, "dagster", fake_dagster)

    definitions = build_finlab_dagster_definitions(_graph())

    assert len(captured_specs) == 3
    assert len(definitions.assets) == 3
    assert definitions.assets[0].spec.key.path == ("finlab", "parity", "daily_price", "raw")
    assert len(definitions.asset_checks) == 1
    assert len(definitions.asset_checks[0]._dagster_specs) == 3
    assert definitions.schedules == []
