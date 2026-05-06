"""Persistence helpers for promotion-grade backtest replay results."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _trade_to_dict(trade: Any) -> dict[str, Any]:
    return {
        "symbol": getattr(trade, "symbol", None),
        "entry_date": getattr(trade, "entry_date", None),
        "exit_date": getattr(trade, "exit_date", None),
        "entry_price": _num(getattr(trade, "entry_price", 0.0)),
        "exit_price": _num(getattr(trade, "exit_price", 0.0)),
        "shares": int(getattr(trade, "shares", 0) or 0),
        "profit_ratio": _num(getattr(trade, "profit_ratio", 0.0)),
        "exit_reason": getattr(trade, "exit_reason", None),
        "days_held": int(getattr(trade, "days_held", 0) or 0),
        "entry_regime": getattr(trade, "entry_regime", None),
    }


def build_replay_backtest_insert(
    metrics: Any,
    *,
    run_date: str | None = None,
    strategy: str | None = None,
    parity_audit: dict[str, Any] | None = None,
    validation_packet: dict[str, Any] | None = None,
    metric_explanations: list[dict[str, Any]] | None = None,
    strategy_lab_record: dict[str, Any] | None = None,
    walk_forward: dict[str, Any] | None = None,
) -> tuple[str, list[Any]]:
    run_date = run_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    mode = str(getattr(metrics, "mode", "") or "unknown").upper()
    trades = [_trade_to_dict(t) for t in (getattr(metrics, "trades", None) or [])]
    raw = {
        "mode": mode,
        "source": "backtest_replay",
        "summary": {
            "total_trades": int(getattr(metrics, "total_trades", 0) or 0),
            "win_rate": _num(getattr(metrics, "win_rate", 0.0)),
            "sharpe": _num(getattr(metrics, "sharpe", 0.0)),
            "sortino": _num(getattr(metrics, "sortino", 0.0)),
            "calmar": _num(getattr(metrics, "calmar", 0.0)),
            "max_drawdown": _num(getattr(metrics, "max_drawdown", 1.0), 1.0),
            "profit_factor": _num(getattr(metrics, "profit_factor", 0.0)),
            "expectancy": _num(getattr(metrics, "expectancy", 0.0)),
            "cagr": _num(getattr(metrics, "cagr", 0.0)),
        },
        "per_regime": getattr(metrics, "per_regime", {}) or {},
        "realism_warnings": getattr(metrics, "realism_warnings", []) or [],
        "absolute_confidence": getattr(metrics, "absolute_confidence", None),
        "sanity_flags": getattr(metrics, "sanity_flags", []) or [],
        "parity_audit": parity_audit or {},
        "partition_returns": getattr(metrics, "partition_returns", []) or [],
        "validation_packet": validation_packet or {},
        "metric_explanations": metric_explanations or [],
        "strategy_lab_record": strategy_lab_record or {},
        "walk_forward": walk_forward or {},
        "all_returns": [t["profit_ratio"] for t in trades],
        "all_regimes": [str(t.get("entry_regime") or "unknown") for t in trades],
        "trades": trades[:500],
    }
    raw_json = json.dumps(raw, ensure_ascii=False)
    sql = """
        INSERT OR REPLACE INTO backtest_results
        (run_date, strategy, timerange, total_trades, win_rate,
         sharpe, sortino, calmar, max_drawdown, cagr,
         profit_factor, expectancy, raw_results)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    params = [
        run_date,
        strategy or f"replay_mode_{mode.lower()}",
        f"{getattr(metrics, 'start_date', '')}~{getattr(metrics, 'end_date', '')}",
        int(getattr(metrics, "total_trades", 0) or 0),
        _num(getattr(metrics, "win_rate", 0.0)),
        _num(getattr(metrics, "sharpe", 0.0)),
        _num(getattr(metrics, "sortino", 0.0)),
        _num(getattr(metrics, "calmar", 0.0)),
        _num(getattr(metrics, "max_drawdown", 1.0), 1.0),
        _num(getattr(metrics, "cagr", 0.0)),
        _num(getattr(metrics, "profit_factor", 0.0)),
        _num(getattr(metrics, "expectancy", 0.0)),
        raw_json[:50000],
    ]
    return sql, params


def persist_replay_backtest(
    metrics: Any,
    *,
    run_date: str | None = None,
    parity_audit: dict[str, Any] | None = None,
    validation_packet: dict[str, Any] | None = None,
    metric_explanations: list[dict[str, Any]] | None = None,
    strategy_lab_record: dict[str, Any] | None = None,
    walk_forward: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from services.d1_client import execute

    sql, params = build_replay_backtest_insert(
        metrics,
        run_date=run_date,
        parity_audit=parity_audit,
        validation_packet=validation_packet,
        metric_explanations=metric_explanations,
        strategy_lab_record=strategy_lab_record,
        walk_forward=walk_forward,
    )
    return execute(sql, params=params, timeout=60.0)
