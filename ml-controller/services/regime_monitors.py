from __future__ import annotations

import math
from typing import Any


WARNING_THRESHOLD = 0.70


def _to_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _history_rows(market_env: dict[str, Any]) -> list[dict[str, Any]]:
    history = market_env.get("history") or {}
    if not isinstance(history, dict):
        return []
    rows: list[dict[str, Any]] = []
    for date_key, row in sorted(history.items()):
        if isinstance(row, dict):
            rows.append({"date": str(date_key), **row})
    return rows


def _daily_returns(rows: list[dict[str, Any]]) -> list[float]:
    out: list[float] = []
    for row in rows:
        raw = row.get("market_return_1d") if row.get("market_return_1d") is not None else row.get("twii_return_1d")
        value = _to_float(raw)
        if value is not None:
            out.append(max(-0.35, min(0.35, value)))
    return out


def _compound_return(values: list[float]) -> float:
    acc = 1.0
    for value in values:
        acc *= 1.0 + value
    return acc - 1.0


def _weekly_returns(daily: list[float]) -> list[float]:
    return [_compound_return(daily[idx:idx + 5]) for idx in range(0, len(daily), 5) if len(daily[idx:idx + 5]) == 5]


def _clip01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _status(score: float | None, enough_data: bool) -> str:
    if not enough_data:
        return "insufficient_data"
    if score is not None and score >= WARNING_THRESHOLD:
        return "warning"
    return "available"


def _provided_score_monitor(score: float | None, *, method: str) -> dict[str, Any] | None:
    if score is None:
        return None
    clean = _clip01(score)
    return {
        "status": _status(clean, True),
        "score": round(clean, 4),
        "warning_threshold": WARNING_THRESHOLD,
        "decision_effect": "context_only",
        "method": method,
        "signals": {"provided_score": clean},
    }


def build_lppls_weekly_bubble_monitor(market_env: dict[str, Any]) -> dict[str, Any]:
    provided = _provided_score_monitor(_to_float(market_env.get("lppls_bubble_score")), method="provided_lppls_score")
    if provided:
        return provided

    rows = _history_rows(market_env)
    daily = _daily_returns(rows)
    weekly = _weekly_returns(daily)
    return {
        "status": "missing_exact_input",
        "score": None,
        "warning_threshold": WARNING_THRESHOLD,
        "decision_effect": "context_only",
        "method": "exact_lppls_score_required",
        "signals": {
            "daily_rows": len(daily),
            "weekly_rows": len(weekly),
            "required_input": "market_env.lppls_bubble_score",
        },
    }


def build_hawkes_contagion_monitor(market_env: dict[str, Any]) -> dict[str, Any]:
    provided = _provided_score_monitor(_to_float(market_env.get("hawkes_contagion_intensity")), method="provided_hawkes_score")
    if provided:
        return provided

    rows = _history_rows(market_env)
    daily = _daily_returns(rows)
    return {
        "status": "missing_exact_input",
        "score": None,
        "warning_threshold": WARNING_THRESHOLD,
        "decision_effect": "context_only",
        "method": "exact_hawkes_intensity_required",
        "signals": {
            "daily_rows": len(daily),
            "required_input": "market_env.hawkes_contagion_intensity",
        },
    }


def build_regime_monitors(market_env: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        "lppls_weekly_bubble": build_lppls_weekly_bubble_monitor(market_env),
        "hawkes_contagion": build_hawkes_contagion_monitor(market_env),
    }
