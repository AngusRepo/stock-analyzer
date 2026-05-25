"""Read-only FinLab / Sinopac execution-lane smoke checks.

This module intentionally never calls ``OrderExecutor.create_orders`` because
FinLab currently calls ``cancel_orders`` before honoring ``view_only=True``.
For preview smoke it uses ``generate_orders`` + ``execute_orders`` with
``view_only=True`` and ``cancel_orders=False``.
"""

from __future__ import annotations

import os
import traceback
from pathlib import Path
from typing import Any, Callable


SCHEMA_VERSION = "finlab-execution-smoke-v1"
REQUIRED_ENV = [
    "SHIOAJI_API_KEY",
    "SHIOAJI_CERT_PERSON_ID",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_ACCOUNT_ID",
    "SHIOAJI_CERT_PATH",
]


def _has_secret_key(env: dict[str, str]) -> bool:
    return bool(env.get("SHIOAJI_SECRET_KEY") or env.get("SHIOAJI_API_SECRET"))


def finlab_execution_env_status(env: dict[str, str] | None = None) -> dict[str, Any]:
    values = env or os.environ
    missing = [key for key in REQUIRED_ENV if not values.get(key)]
    if not _has_secret_key(values):
        missing.append("SHIOAJI_SECRET_KEY_OR_SHIOAJI_API_SECRET")

    cert_path = values.get("SHIOAJI_CERT_PATH")
    cert_exists = bool(cert_path and Path(cert_path).exists())
    if cert_path and not cert_exists and "SHIOAJI_CERT_PATH" not in missing:
        missing.append("SHIOAJI_CERT_PATH_EXISTS")

    mode = (values.get("FINLAB_EXECUTION_LANE_ENABLED") or "off").strip().lower()
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": mode,
        "ready": len(missing) == 0,
        "missing": missing,
        "cert_path_configured": bool(cert_path),
        "cert_path_exists": cert_exists,
        "secret_key_configured": _has_secret_key(values),
    }


def _load_finlab_factories() -> tuple[Callable[[], Any], type]:
    from finlab.online import OrderExecutor
    from finlab.online.sinopac_account import SinopacAccount

    return SinopacAccount, OrderExecutor


def _safe_count_position(position: Any) -> int:
    if hasattr(position, "to_list"):
        try:
            return len(position.to_list())
        except Exception:
            pass
    return len(getattr(position, "position", []) or [])


def _read_optional_number(account: Any, method_name: str) -> tuple[bool, str | None]:
    method = getattr(account, method_name, None)
    if not callable(method):
        return False, "missing_method"
    try:
        method()
        return True, None
    except Exception as exc:  # pragma: no cover - broker-specific surface
        return False, exc.__class__.__name__


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


def _error_payload(exc: BaseException, env_status: dict[str, Any], steps: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "allowed_use": "read_only_smoke",
        "status": "error",
        "can_submit_real_order": False,
        "env_status": env_status,
        "steps": steps,
        "error_type": exc.__class__.__name__,
        "error": str(exc),
        "trace_tail": traceback.format_exc(limit=2),
    }


def run_finlab_execution_smoke(
    *,
    env: dict[str, str] | None = None,
    allow_broker_login: bool = False,
    preview_noop: bool = True,
    account_factory: Callable[[], Any] | None = None,
    order_executor_factory: type | None = None,
) -> dict[str, Any]:
    values = env or os.environ
    env_status = finlab_execution_env_status(values)
    steps: list[dict[str, Any]] = []

    if not env_status["ready"]:
        return {
            "schema_version": SCHEMA_VERSION,
            "allowed_use": "read_only_smoke",
            "status": "blocked",
            "can_submit_real_order": False,
            "blocked_reasons": env_status["missing"],
            "env_status": env_status,
            "steps": steps,
        }

    if not allow_broker_login:
        return {
            "schema_version": SCHEMA_VERSION,
            "allowed_use": "read_only_smoke",
            "status": "blocked",
            "can_submit_real_order": False,
            "blocked_reasons": ["broker_login_not_allowed"],
            "env_status": env_status,
            "steps": steps,
        }

    account: Any | None = None
    try:
        if account_factory is None or order_executor_factory is None:
            loaded_account_factory, loaded_order_executor_factory = _load_finlab_factories()
            account_factory = account_factory or loaded_account_factory
            order_executor_factory = order_executor_factory or loaded_order_executor_factory

        account = account_factory()
        steps.append({"name": "sinopac_account_login", "status": "pass"})

        position = account.get_position()
        position_count = _safe_count_position(position)
        steps.append({"name": "account_position_readback", "status": "pass", "position_count": position_count})

        cash_ok, cash_error = _read_optional_number(account, "get_cash")
        settlement_ok, settlement_error = _read_optional_number(account, "get_settlement")
        total_balance_ok, total_balance_error = _read_optional_number(account, "get_total_balance")
        account_readback = {
            "position_count": position_count,
            "cash_readable": cash_ok,
            "cash_error": cash_error,
            "settlement_readable": settlement_ok,
            "settlement_error": settlement_error,
            "total_balance_readable": total_balance_ok,
            "total_balance_error": total_balance_error,
        }

        preview: dict[str, Any] | None = None
        if preview_noop:
            executor = order_executor_factory(position, account)
            orders = executor.generate_orders(
                progress=1,
                progress_precision=0,
                as_entries=False,
                _internal=True,
            )
            executed = executor.execute_orders(
                orders,
                view_only=True,
                cancel_orders=False,
                market_order=False,
                best_price_limit=False,
                extra_bid_pct=0,
                buy_only=False,
                sell_only=False,
            )
            preview = {
                "mode": "noop_current_position",
                "view_only": True,
                "cancel_orders": False,
                "generated_orders": len(orders),
                "executed_orders": len(executed),
                "uses_create_orders": False,
            }
            steps.append({"name": "noop_view_only_preview", "status": "pass", **preview})

        return {
            "schema_version": SCHEMA_VERSION,
            "allowed_use": "read_only_smoke",
            "status": "pass",
            "can_submit_real_order": False,
            "env_status": env_status,
            "steps": steps,
            "account_readback": account_readback,
            "preview": preview,
        }
    except Exception as exc:
        steps.append({"name": "smoke_exception", "status": "error", "error_type": exc.__class__.__name__})
        return _error_payload(exc, env_status, steps)
    finally:
        if account is not None:
            _logout_account(account)
