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


def _tw_tick_size(price: float) -> float:
    if price < 10:
        return 0.01
    if price < 50:
        return 0.05
    if price < 100:
        return 0.1
    if price < 500:
        return 0.5
    if price < 1000:
        return 1
    return 5


def _is_tw_tick_price(price: float) -> bool:
    if price <= 0:
        return False
    tick = _tw_tick_size(price)
    scaled_price = round(price * 100)
    scaled_tick = max(1, round(tick * 100))
    return scaled_price % scaled_tick == 0


def _validate_order_legs(intent: dict[str, Any], requested_shares: int) -> str | None:
    legs = intent.get("orderLegs") or intent.get("order_legs")
    if not isinstance(legs, list) or not legs:
        return "stockvision_intent_missing_order_legs"

    total_shares = 0
    for leg in legs:
        if not isinstance(leg, dict):
            return "stockvision_intent_invalid_order_leg"
        lot_type = str(leg.get("lotType") or leg.get("lot_type") or "")
        shares = int(leg.get("shares") or 0)
        finlab_quantity = int(leg.get("finlabQuantity") or leg.get("finlab_quantity") or 0)
        odd_lot = bool(leg.get("oddLot") if "oddLot" in leg else leg.get("odd_lot"))

        if lot_type == "board_lot":
            if shares <= 0 or shares % 1000 != 0:
                return "stockvision_intent_invalid_board_lot_shares"
            if finlab_quantity != shares // 1000 or odd_lot:
                return "stockvision_intent_invalid_board_lot_finlab_quantity"
        elif lot_type == "odd_lot":
            if shares <= 0 or shares >= 1000:
                return "stockvision_intent_invalid_odd_lot_shares"
            if finlab_quantity != shares or not odd_lot:
                return "stockvision_intent_invalid_odd_lot_finlab_quantity"
        else:
            return "stockvision_intent_unknown_order_lot_type"
        total_shares += shares

    if total_shares != requested_shares:
        return "stockvision_intent_order_legs_share_mismatch"
    return None


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


def validate_stockvision_execution_intent(intent: dict[str, Any]) -> str | None:
    if intent.get("liveSubmitRequested") is True or intent.get("live_submit_requested") is True:
        return "stockvision_intent_requested_live_submit"
    if not intent.get("symbol"):
        return "stockvision_intent_missing_symbol"
    side = str(intent.get("side") or "buy").lower()
    if side not in {"buy", "sell"}:
        return "stockvision_intent_side_not_supported_pre_pilot"
    raw_price = (
        intent.get("maxPrice")
        or intent.get("max_price")
        or intent.get("minPrice")
        or intent.get("min_price")
        or intent.get("limitPrice")
        or intent.get("limit_price")
        or 0
    )
    if side == "sell":
        raw_price = (
            intent.get("minPrice")
            or intent.get("min_price")
            or intent.get("limitPrice")
            or intent.get("limit_price")
            or intent.get("maxPrice")
            or intent.get("max_price")
            or 0
        )
    limit_price = float(raw_price)
    if limit_price <= 0:
        return "stockvision_intent_invalid_limit_price"
    if not _is_tw_tick_price(limit_price):
        return "stockvision_intent_invalid_tw_tick_price"
    requested_shares = int(intent.get("requestedShares") or intent.get("requested_shares") or 0)
    if requested_shares <= 0:
        return "stockvision_intent_invalid_requested_shares"
    leg_error = _validate_order_legs(intent, requested_shares)
    if leg_error:
        return leg_error
    return None


def run_finlab_execution_preview(
    *,
    intent: dict[str, Any],
    allow_broker_login: bool = False,
    preview_factory: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    reason = validate_stockvision_execution_intent(intent)
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
