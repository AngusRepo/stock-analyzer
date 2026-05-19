from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ML_CONTROLLER = ROOT / "ml-controller"
sys.path.insert(0, str(ML_CONTROLLER))


def _install_fake_dagster(monkeypatch):
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

    class FakeDefinitions:
        def __init__(self, *, assets, asset_checks=None, schedules=None):
            self.assets = assets
            self.asset_checks = asset_checks or []
            self.schedules = schedules or []

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

    def fake_external_assets_from_specs(specs):
        return list(specs)

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


def test_requirements_pin_dagster_runtime_dependency():
    requirements = (ML_CONTROLLER / "requirements.txt").read_text(encoding="utf-8")

    assert "dagster==1.13.4" in requirements


def test_finlab_v4_code_location_exposes_formal_shadow_asset_runtime(monkeypatch):
    _install_fake_dagster(monkeypatch)
    sys.modules.pop("dagster_defs.finlab_v4", None)

    module = importlib.import_module("dagster_defs.finlab_v4")

    assert module.DEFINITIONS_STATUS["schedule_enabled"] is False
    assert module.DEFINITIONS_STATUS["mode"] == "finlab_asset_runtime_formal_shadow"
    assert module.defs is not None
    assert len(module.defs.assets) == 45
    assert len(module.defs.asset_checks) == 1
    assert module.DEFINITIONS_STATUS["asset_check_def_count"] == 1
    assert len(module.defs.asset_checks[0]._dagster_specs) == 190
    assert module.defs.schedules == []
