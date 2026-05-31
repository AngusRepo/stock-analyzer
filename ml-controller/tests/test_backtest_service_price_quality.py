from __future__ import annotations

import sys
import types
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

httpx_stub = types.ModuleType("httpx")
httpx_stub.AsyncClient = object
sys.modules.setdefault("httpx", httpx_stub)

from services.backtest_service import _run_backtest_for_stock  # noqa: E402


def _price_rows(count: int = 31) -> list[dict]:
    start = date(2026, 5, 1)
    rows = []
    for idx in range(count):
        rows.append({
            "date": (start + timedelta(days=idx)).isoformat(),
            "open": 10.0,
            "high": 11.0,
            "low": 9.0,
            "close": 10.0,
            "volume": 1000,
        })
    return rows


def test_backtest_skips_price_rows_without_close() -> None:
    prices = _price_rows()
    prices[5]["close"] = None

    assert _run_backtest_for_stock(prices, []) == []
