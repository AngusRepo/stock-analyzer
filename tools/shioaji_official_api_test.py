from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Any


SENSITIVE_KEYS = [
    "SHIOAJI_API_KEY",
    "SHIOAJI_SECRET_KEY",
    "SHIOAJI_API_SECRET",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_CERT_PERSON_ID",
    "SHIOAJI_ACCOUNT_ID",
]


def _mask(value: str | None, keep: int = 6) -> str:
    if not value:
        return ""
    if len(value) <= keep * 2:
        return "***"
    return f"{value[:keep]}...{value[-keep:]}"


def _sanitize(text: str) -> str:
    sanitized = text
    for key in SENSITIVE_KEYS:
        value = os.environ.get(key)
        if value and len(value) >= 3:
            sanitized = sanitized.replace(value, "***")
    return sanitized


def _account_summary(account: Any) -> dict[str, Any]:
    return {
        "type": account.__class__.__name__,
        "broker_id": getattr(account, "broker_id", ""),
        "account_id_mask": _mask(str(getattr(account, "account_id", "") or getattr(account, "account", "")), keep=3),
        "signed": getattr(account, "signed", None),
    }


def _contract(api: Any, stock_code: str) -> Any:
    tse_name = f"TSE{stock_code}"
    contract = getattr(api.Contracts.Stocks.TSE, tse_name, None)
    if contract is not None:
        return contract
    getter = getattr(api.Contracts.Stocks, "get", None)
    if callable(getter):
        contract = getter(stock_code)
        if contract is not None:
            return contract
    raise RuntimeError(f"stock contract not found: {stock_code}")


def run_test(*, stock_code: str, price: float, quantity: int, place_stock_order: bool) -> dict[str, Any]:
    import shioaji as sj
    from shioaji.constant import (
        Action,
        OrderType,
        StockOrderCond,
        StockOrderLot,
        StockPriceType,
    )
    from shioaji.order import StockOrder

    api_key = os.environ.get("SHIOAJI_API_KEY", "")
    secret_key = os.environ.get("SHIOAJI_SECRET_KEY") or os.environ.get("SHIOAJI_API_SECRET", "")
    cert_path = os.environ.get("SHIOAJI_CERT_PATH", "")
    cert_password = os.environ.get("SHIOAJI_CERT_PASSWORD", "")
    cert_person_id = os.environ.get("SHIOAJI_CERT_PERSON_ID", "")

    missing = [
        name
        for name, value in {
            "SHIOAJI_API_KEY": api_key,
            "SHIOAJI_SECRET_KEY_OR_SHIOAJI_API_SECRET": secret_key,
            "SHIOAJI_CERT_PATH": cert_path,
            "SHIOAJI_CERT_PASSWORD": cert_password,
            "SHIOAJI_CERT_PERSON_ID": cert_person_id,
        }.items()
        if not value
    ]
    if missing:
        return {
            "status": "blocked",
            "mode": "simulation",
            "can_submit_real_order": False,
            "missing": missing,
        }

    api = sj.Shioaji(simulation=True)
    try:
        accounts = api.login(api_key=api_key, secret_key=secret_key)
        api.activate_ca(
            ca_path=cert_path,
            ca_passwd=cert_password,
            person_id=cert_person_id,
        )
        output: dict[str, Any] = {
            "status": "pass",
            "mode": "simulation",
            "can_submit_real_order": False,
            "shioaji_version": getattr(sj, "__version__", ""),
            "api_key_mask": _mask(api_key),
            "login": {
                "status": "pass",
                "account_count": len(accounts or []),
                "accounts": [_account_summary(account) for account in (accounts or [])],
            },
            "activate_ca": {"status": "pass"},
            "place_order": {"status": "skipped"},
        }
        if not place_stock_order:
            return output

        contract = _contract(api, stock_code)
        order = StockOrder(
            action=Action.Buy,
            price=price,
            quantity=quantity,
            price_type=StockPriceType.LMT,
            order_type=OrderType.ROD,
            order_lot=StockOrderLot.Common,
            order_cond=StockOrderCond.Cash,
            account=api.stock_account,
        )
        trade = api.place_order(contract, order)
        status = getattr(trade, "status", None)
        output["place_order"] = {
            "status": "pass",
            "stock_code": stock_code,
            "price": price,
            "quantity": quantity,
            "simulation": True,
            "status_code": str(getattr(status, "status_code", "")),
            "order_status": str(getattr(status, "status", "")),
            "order_id_mask": _mask(str(getattr(status, "id", "")), keep=2),
        }
        return output
    except Exception as exc:
        return {
            "status": "error",
            "mode": "simulation",
            "can_submit_real_order": False,
            "error_type": exc.__class__.__name__,
            "error": _sanitize(str(exc)),
            "trace_tail": _sanitize(traceback.format_exc(limit=2)),
        }
    finally:
        try:
            api.logout()
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Official Shioaji simulation API test.")
    parser.add_argument("--stock-code", default="2890")
    parser.add_argument("--price", type=float, default=28)
    parser.add_argument("--quantity", type=int, default=1)
    parser.add_argument("--place-stock-order", action="store_true")
    args = parser.parse_args()

    result = run_test(
        stock_code=args.stock_code,
        price=args.price,
        quantity=args.quantity,
        place_stock_order=args.place_stock_order,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") != "pass":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
