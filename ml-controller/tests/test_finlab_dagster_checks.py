from __future__ import annotations

import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_dagster_checks import build_finlab_dagster_check_defs  # noqa: E402
from services.finlab_dagster_factory import build_finlab_definitions_payload  # noqa: E402


def _payload() -> dict:
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
                "check_name": "field_count_positive",
                "severity": "error",
            },
            {
                "asset_key": "finlab/parity/daily_price/raw",
                "check_name": "freshness",
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
    return build_finlab_definitions_payload(graph)


def _fake_dagster(monkeypatch):
    fake_dagster = types.ModuleType("dagster")

    class FakeAssetKey:
        def __init__(self, path):
            self.path = tuple(path)

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

    def fake_multi_asset_check(*, specs, name):
        def decorator(fn):
            fn._dagster_specs = specs
            fn._dagster_name = name
            return fn

        return decorator

    fake_dagster.AssetKey = FakeAssetKey
    fake_dagster.AssetCheckSpec = FakeAssetCheckSpec
    fake_dagster.AssetCheckResult = FakeAssetCheckResult
    fake_dagster.AssetCheckSeverity = FakeAssetCheckSeverity
    fake_dagster.multi_asset_check = fake_multi_asset_check
    monkeypatch.setitem(sys.modules, "dagster", fake_dagster)
    return fake_dagster


def test_build_finlab_dagster_check_defs_creates_one_multi_asset_check(monkeypatch):
    fake_dagster = _fake_dagster(monkeypatch)

    check_defs = build_finlab_dagster_check_defs(_payload(), dagster_module=fake_dagster)

    assert len(check_defs) == 1
    assert check_defs[0]._dagster_name == "finlab_v4_formal_shadow_quality_checks"
    assert len(check_defs[0]._dagster_specs) == 2
    assert check_defs[0]._dagster_specs[0].asset.path == ("finlab", "parity", "daily_price", "raw")


def test_finlab_dagster_check_def_yields_formal_shadow_asset_check_results(monkeypatch):
    fake_dagster = _fake_dagster(monkeypatch)
    check_def = build_finlab_dagster_check_defs(_payload(), dagster_module=fake_dagster)[0]

    results = list(check_def())

    assert len(results) == 2
    assert results[0].kwargs["passed"] is True
    assert results[0].kwargs["asset_key"].path == ("finlab", "parity", "daily_price", "raw")
    assert results[0].kwargs["check_name"] == "field_count_positive"
    assert results[0].kwargs["metadata"]["materialization_mode"] == "formal_shadow"
    assert results[0].kwargs["metadata"]["production_write_enabled"] is False
    assert results[1].kwargs["metadata"]["status"] == "observed"
