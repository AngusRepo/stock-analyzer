"""StockVision legal order intent -> FinLab/Sinopac live submit adapter.

Live submit is disabled unless ``FINLAB_LIVE_SUBMIT_ENABLED`` is explicitly
truthy and the caller sets ``allow_live_submit=True``. The adapter exists so
pre-live paper/preview flows use the same legal broker contract that real
orders will use later.
"""

from __future__ import annotations

import os
import traceback
from typing import Any, Callable

from finlab.online import Action, OrderCondition

from services.finlab_execution_preview_service import validate_stockvision_execution_intent
from services.finlab_sinopac_l5_market_data import l5_market_data_env_status


SCHEMA_VERSION = "finlab-live-submit-service-v1"
SENSITIVE_ENV_KEYS = [
    "SHIOAJI_API_KEY",
    "SHIOAJI_SECRET_KEY",
    "SHIOAJI_API_SECRET",
    "SHIOAJI_CERT_PERSON_ID",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_ACCOUNT_ID",
]


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "enabled"}


def _blocked(intent: dict[str, Any], reason: str, *, env_status: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "blocked",
        "reason": reason,
        "blocked_reasons": [reason],
        "symbol": str(intent.get("symbol") or ""),
        "side": str(intent.get("side") or ""),
        "submitted_orders": [],
        "can_submit_real_order": False,
        "live_submit_enabled": False,
        "env_status": env_status,
    }


def _sanitize(text: str, env: dict[str, str]) -> str:
    sanitized = text
    for key in SENSITIVE_ENV_KEYS:
        value = env.get(key)
        if value and len(value) >= 3:
            sanitized = sanitized.replace(value, "***")
    return sanitized


def _load_account_factory() -> Callable[[], Any]:
    from finlab.online.brokers.sinopac import SinopacAccount

    return SinopacAccount


def _logout_account(account: Any) -> None:
    for candidate in (
        getattr(account, "logout", None),
        getattr(getattr(account, "api", None), "logout", None),
    ):
        if callable(candidate):
            try:
                candidate()
            except Exception:
                pass
            return


def _action(side: str) -> Action:
    return Action.BUY if side == "buy" else Action.SELL


def _limit_price(intent: dict[str, Any]) -> float:
    side = str(intent.get("side") or "buy").lower()
    if side == "sell":
        return float(intent.get("minPrice") or intent.get("min_price") or intent.get("limitPrice") or intent.get("limit_price") or 0)
    return float(intent.get("maxPrice") or intent.get("max_price") or intent.get("limitPrice") or intent.get("limit_price") or 0)


def _order_legs(intent: dict[str, Any]) -> list[dict[str, Any]]:
    legs = intent.get("orderLegs") or intent.get("order_legs") or []
    return [leg for leg in legs if isinstance(leg, dict)]


def run_finlab_live_submit(
    *,
    intent: dict[str, Any],
    allow_live_submit: bool = False,
    env: dict[str, str] | None = None,
    account_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    values = env or os.environ
    intent_error = validate_stockvision_execution_intent(intent)
    if intent_error:
        return _blocked(intent, intent_error)

    env_status = l5_market_data_env_status(values)
    live_submit_enabled = _truthy(values.get("FINLAB_LIVE_SUBMIT_ENABLED"))
    if not live_submit_enabled:
        return _blocked(intent, "finlab_live_submit_disabled", env_status=env_status)
    if not allow_live_submit:
        return _blocked(intent, "allow_live_submit_required", env_status=env_status)
    if not env_status["ready"]:
        return _blocked(intent, "broker_env_not_ready", env_status=env_status)

    symbol = str(intent.get("symbol") or "")
    side = str(intent.get("side") or "").lower()
    price = _limit_price(intent)
    submitted: list[dict[str, Any]] = []
    account: Any | None = None

    try:
        factory = account_factory or _load_account_factory()
        account = factory()
        for leg in _order_legs(intent):
            quantity = int(leg.get("finlabQuantity") or leg.get("finlab_quantity") or 0)
            odd_lot = bool(leg.get("oddLot") if "oddLot" in leg else leg.get("odd_lot"))
            order_id = account.create_order(
                action=_action(side),
                stock_id=symbol,
                quantity=quantity,
                price=price,
                odd_lot=odd_lot,
                market_order=False,
                best_price_limit=False,
                order_cond=OrderCondition.CASH,
            )
            submitted.append({
                "lot_type": str(leg.get("lotType") or leg.get("lot_type")),
                "shares": int(leg.get("shares") or 0),
                "finlab_quantity": quantity,
                "odd_lot": odd_lot,
                "order_id": str(order_id),
            })

        return {
            "schema_version": SCHEMA_VERSION,
            "status": "submitted",
            "symbol": symbol,
            "side": side,
            "price": price,
            "submitted_orders": submitted,
            "can_submit_real_order": True,
            "live_submit_enabled": True,
            "env_status": env_status,
        }
    except Exception as exc:
        return {
            "schema_version": SCHEMA_VERSION,
            "status": "error",
            "symbol": symbol,
            "side": side,
            "submitted_orders": submitted,
            "can_submit_real_order": live_submit_enabled,
            "live_submit_enabled": live_submit_enabled,
            "env_status": env_status,
            "error_type": exc.__class__.__name__,
            "error": _sanitize(str(exc), values),
            "trace_tail": _sanitize(traceback.format_exc(limit=2), values),
        }
    finally:
        if account is not None:
            _logout_account(account)
