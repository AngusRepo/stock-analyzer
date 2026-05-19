from __future__ import annotations

import importlib
from typing import Any

from services.finlab_quality_checks import evaluate_finlab_check_specs


def _severity(dagster: Any, severity: str) -> Any:
    if str(severity).lower() == "warn":
        return dagster.AssetCheckSeverity.WARN
    return dagster.AssetCheckSeverity.ERROR


def build_finlab_dagster_check_defs(
    payload: dict[str, Any],
    *,
    dagster_module: Any | None = None,
) -> list[Any]:
    dagster = dagster_module or importlib.import_module("dagster")
    if not hasattr(dagster, "multi_asset_check"):
        return []
    specs = [
        dagster.AssetCheckSpec(
            name=str(check["name"]),
            asset=dagster.AssetKey(check["asset_key"]),
        )
        for check in payload.get("asset_checks") or []
    ]
    if not specs:
        return []

    @dagster.multi_asset_check(
        specs=specs,
        name="finlab_v4_formal_shadow_quality_checks",
    )
    def finlab_v4_formal_shadow_quality_checks():
        for result in evaluate_finlab_check_specs(payload):
            yield dagster.AssetCheckResult(
                passed=result.passed,
                asset_key=dagster.AssetKey(result.asset_key),
                check_name=result.check_name,
                severity=_severity(dagster, result.severity),
                description=result.reason,
                metadata=result.metadata,
            )

    return [finlab_v4_formal_shadow_quality_checks]
