"""StockVision intent -> FinLab execution preview bridge.

Pre-pilot safety: this service never submits orders. It normalizes preview
results into the existing FinLab execution preview contract and fails closed
when a live-submit flag or broker order id appears.
"""

from __future__ import annotations

from typing import Any, Callable

from services.finlab_execution_adapter import (
    normalize_finlab_execution_preview,
    validate_finlab_execution_preview_contract,
)


SCHEMA_VERSION = "finlab-execution-preview-service-v1"


def _blocked(intent: dict[str, Any], reason: str) -> dict[str, Any]:
    preview = normalize_finlab_execution_preview(
        {"status": "blocked", "reason": reason},
        symbol=str(intent.get("symbol") or ""),
        side=str(intent.get("side") or "buy"),
    ).to_dict()
    preview["service_schema_version"] = SCHEMA_VERSION
    return preview


def _error(intent: dict[str, Any], reason: str) -> dict[str, Any]:
    preview = normalize_finlab_execution_preview(
        {"status": "error", "reason": reason},
        symbol=str(intent.get("symbol") or ""),
        side=str(intent.get("side") or "buy"),
    ).to_dict()
    preview["service_schema_version"] = SCHEMA_VERSION
    return preview


def _validate_intent(intent: dict[str, Any]) -> str | None:
    if intent.get("liveSubmitRequested") is True or intent.get("live_submit_requested") is True:
        return "stockvision_intent_requested_live_submit"
    if not intent.get("symbol"):
        return "stockvision_intent_missing_symbol"
    if str(intent.get("side") or "buy").lower() != "buy":
        return "stockvision_intent_side_not_supported_pre_pilot"
    if float(intent.get("maxPrice") or intent.get("max_price") or 0) <= 0:
        return "stockvision_intent_invalid_max_price"
    if int(intent.get("requestedShares") or intent.get("requested_shares") or 0) <= 0:
        return "stockvision_intent_invalid_requested_shares"
    return None


def run_finlab_execution_preview(
    *,
    intent: dict[str, Any],
    allow_broker_login: bool = False,
    preview_factory: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    reason = _validate_intent(intent)
    if reason:
        return _blocked(intent, reason)

    if not allow_broker_login:
        return _blocked(intent, "broker_login_not_allowed")

    if preview_factory is None:
        return _blocked(intent, "finlab_preview_factory_unavailable")

    try:
        raw_preview = preview_factory(intent)
    except Exception as exc:  # pragma: no cover - broker/runtime surface
        return _error(intent, f"finlab_preview_exception:{exc.__class__.__name__}")

    violations = validate_finlab_execution_preview_contract(raw_preview)
    if violations:
        return _blocked(intent, ",".join(violations))

    preview = normalize_finlab_execution_preview(
        raw_preview,
        symbol=str(intent.get("symbol") or ""),
        side=str(intent.get("side") or "buy"),
    ).to_dict()
    preview["service_schema_version"] = SCHEMA_VERSION
    preview["live_submit_enabled"] = False
    preview["can_submit_real_order"] = False
    return preview
