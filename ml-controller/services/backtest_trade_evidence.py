"""Compact, complete algorithmic trade evidence shared by MC and PBO."""

from __future__ import annotations

import math
from typing import Any


BACKTEST_TRADE_EVIDENCE_SCHEMA_VERSION = "backtest-trade-evidence-v1"


def _read(trade: Any, key: str) -> Any:
    if isinstance(trade, dict):
        return trade.get(key)
    return getattr(trade, key, None)


def _first(trade: Any, *keys: str) -> Any:
    for key in keys:
        value = _read(trade, key)
        if value is not None and value != "":
            return value
    return None


def build_backtest_trade_evidence(trades: list[Any]) -> dict[str, Any]:
    dates: list[str] = []
    regimes: list[str] = []
    date_index: dict[str, int] = {}
    regime_index: dict[str, int] = {}
    rows: list[list[Any]] = []

    for trade in trades:
        exit_date = str(_first(trade, "exit_date", "entry_date") or "")[:10]
        regime = str(_first(trade, "entry_regime", "regime") or "unknown")
        try:
            profit_ratio = float(_read(trade, "profit_ratio"))
        except (TypeError, ValueError) as exc:
            raise ValueError("backtest_trade_evidence_profit_ratio_invalid") from exc
        if not math.isfinite(profit_ratio):
            raise ValueError("backtest_trade_evidence_profit_ratio_non_finite")
        try:
            holding_days = int(
                _first(
                    trade,
                    "holding_period_days",
                    "days_held",
                    "label_horizon_days",
                    "barrier_horizon_days",
                    "horizon_days",
                )
                or 0
            )
        except (TypeError, ValueError):
            holding_days = 0

        if exit_date not in date_index:
            date_index[exit_date] = len(dates)
            dates.append(exit_date)
        if regime not in regime_index:
            regime_index[regime] = len(regimes)
            regimes.append(regime)
        rows.append([
            date_index[exit_date],
            profit_ratio,
            regime_index[regime],
            max(0, holding_days),
        ])

    return {
        "schema_version": BACKTEST_TRADE_EVIDENCE_SCHEMA_VERSION,
        "complete": True,
        "columns": [
            "exit_date_index",
            "profit_ratio",
            "entry_regime_index",
            "holding_period_days",
        ],
        "dates": dates,
        "regimes": regimes,
        "rows": rows,
        "row_count": len(rows),
    }


def decode_backtest_trade_evidence(raw: dict[str, Any]) -> list[dict[str, Any]]:
    evidence = raw.get("trade_evidence")
    if not isinstance(evidence, dict):
        return []
    if evidence.get("schema_version") != BACKTEST_TRADE_EVIDENCE_SCHEMA_VERSION:
        raise ValueError("backtest_trade_evidence_schema_invalid")
    if evidence.get("complete") is not True:
        raise ValueError("backtest_trade_evidence_incomplete")
    dates = evidence.get("dates")
    regimes = evidence.get("regimes")
    rows = evidence.get("rows")
    if not isinstance(dates, list) or not isinstance(regimes, list) or not isinstance(rows, list):
        raise ValueError("backtest_trade_evidence_shape_invalid")
    if evidence.get("row_count") != len(rows):
        raise ValueError("backtest_trade_evidence_row_count_mismatch")

    decoded: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, list) or len(row) != 4:
            raise ValueError("backtest_trade_evidence_row_invalid")
        date_id, profit_ratio, regime_id, holding_days = row
        try:
            decoded.append({
                "exit_date": str(dates[int(date_id)]),
                "profit_ratio": float(profit_ratio),
                "entry_regime": str(regimes[int(regime_id)]),
                "holding_period_days": max(0, int(holding_days)),
            })
        except (IndexError, TypeError, ValueError) as exc:
            raise ValueError("backtest_trade_evidence_row_reference_invalid") from exc
    return decoded
