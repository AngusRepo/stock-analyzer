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
    if len(weekly) < 8:
        return {
            "status": "insufficient_data",
            "score": None,
            "warning_threshold": WARNING_THRESHOLD,
            "decision_effect": "context_only",
            "method": "lppls_weekly_proxy_v1",
            "signals": {"daily_rows": len(daily), "weekly_rows": len(weekly)},
        }

    last_8w = weekly[-8:]
    first_4w = last_8w[:4]
    last_4w = last_8w[4:]
    momentum_8w = _compound_return(last_8w)
    slope_prev = sum(first_4w) / len(first_4w)
    slope_recent = sum(last_4w) / len(last_4w)
    acceleration_4w = slope_recent - slope_prev

    index = 1.0
    index_curve = []
    for value in last_8w:
        index *= 1.0 + value
        index_curve.append(index)
    peak = max(index_curve) if index_curve else 1.0
    drawdown_8w = (index_curve[-1] / peak - 1.0) if peak else 0.0
    positive_weeks = sum(1 for value in last_8w if value > 0)

    momentum_score = _clip01(momentum_8w / 0.35)
    acceleration_score = _clip01(acceleration_4w / 0.035)
    persistence_score = positive_weeks / len(last_8w)
    drawdown_score = _clip01(1.0 + drawdown_8w / 0.08)
    score = _clip01(
        0.35 * momentum_score
        + 0.30 * acceleration_score
        + 0.20 * persistence_score
        + 0.15 * drawdown_score
    )

    return {
        "status": _status(score, True),
        "score": round(score, 4),
        "warning_threshold": WARNING_THRESHOLD,
        "decision_effect": "context_only",
        "method": "lppls_weekly_proxy_v1",
        "signals": {
            "daily_rows": len(daily),
            "weekly_rows": len(weekly),
            "momentum_8w": round(momentum_8w, 6),
            "acceleration_4w": round(acceleration_4w, 6),
            "positive_weeks_8w": positive_weeks,
            "drawdown_8w": round(drawdown_8w, 6),
        },
    }


def build_hawkes_contagion_monitor(market_env: dict[str, Any]) -> dict[str, Any]:
    provided = _provided_score_monitor(_to_float(market_env.get("hawkes_contagion_intensity")), method="provided_hawkes_score")
    if provided:
        return provided

    rows = _history_rows(market_env)
    daily = _daily_returns(rows)
    if len(daily) < 20:
        return {
            "status": "insufficient_data",
            "score": None,
            "warning_threshold": WARNING_THRESHOLD,
            "decision_effect": "context_only",
            "method": "hawkes_exponential_decay_proxy_v1",
            "signals": {"daily_rows": len(daily)},
        }

    event_weights: list[float] = []
    for idx, row in enumerate(rows[-40:]):
        raw_return = row.get("market_return_1d") if row.get("market_return_1d") is not None else row.get("twii_return_1d")
        ret = _to_float(raw_return) or 0.0
        limit_down_pct = _to_float(row.get("limit_down_pct")) or 0.0
        vix = _to_float(row.get("us_vix")) or _to_float(market_env.get("us_vix")) or 0.0
        hy_chg = _to_float(row.get("us_hy_spread_chg")) or _to_float(market_env.get("us_hy_spread_chg")) or 0.0

        weight = 0.0
        if ret <= -0.02:
            weight += min(1.0, abs(ret) / 0.04)
        if limit_down_pct >= 0.005:
            weight += min(0.8, limit_down_pct / 0.015)
        if vix >= 30:
            weight += min(0.7, (vix - 25.0) / 20.0)
        if hy_chg >= 0.25:
            weight += min(0.6, hy_chg / 0.8)
        event_weights.append(weight)

    decayed_intensity = 0.0
    half_life = 5.0
    for age, weight in enumerate(reversed(event_weights)):
        decayed_intensity += weight * math.exp(-age / half_life)
    shock_count_10d = sum(1 for weight in event_weights[-10:] if weight >= 0.75)
    cluster_score = _clip01(shock_count_10d / 5.0)
    intensity_score = _clip01(decayed_intensity / 6.0)
    score = _clip01(0.70 * intensity_score + 0.30 * cluster_score)

    return {
        "status": _status(score, True),
        "score": round(score, 4),
        "warning_threshold": WARNING_THRESHOLD,
        "decision_effect": "context_only",
        "method": "hawkes_exponential_decay_proxy_v1",
        "signals": {
            "daily_rows": len(daily),
            "shock_count_10d": shock_count_10d,
            "decayed_intensity": round(decayed_intensity, 6),
            "intensity_score": round(intensity_score, 6),
            "cluster_score": round(cluster_score, 6),
        },
    }


def build_regime_monitors(market_env: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        "lppls_weekly_bubble": build_lppls_weekly_bubble_monitor(market_env),
        "hawkes_contagion": build_hawkes_contagion_monitor(market_env),
    }
