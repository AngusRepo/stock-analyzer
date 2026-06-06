from __future__ import annotations

import math
from typing import Any

from services.regime_monitors import build_regime_monitors


REGIME_EVIDENCE_SCHEMA_VERSION = "regime-evidence-v1"


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


def _latest_value(market_env: dict[str, Any], rows: list[dict[str, Any]], key: str) -> float | None:
    direct = _to_float(market_env.get(key))
    if direct is not None:
        return direct
    for row in reversed(rows):
        value = _to_float(row.get(key))
        if value is not None:
            return value
    return None


def _normalize_ratio(value: float | None) -> float | None:
    if value is None:
        return None
    return value / 100.0 if value > 1.0 else value


def _dimension(status: str, stance: str, metrics: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "status": status,
        "stance": stance,
        "metrics": {k: v for k, v in metrics.items() if v is not None},
        "reason": reason,
    }


def _price_trend(market_env: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    ret_1d = _latest_value(market_env, rows, "twii_return_1d")
    ret_5d = _latest_value(market_env, rows, "twii_return_5d")
    bias_20d = _latest_value(market_env, rows, "twii_bias_20d")
    recent_returns = [_to_float(row.get("market_return_1d")) for row in rows[-5:]]
    recent_returns = [x for x in recent_returns if x is not None]
    negative_sessions = sum(1 for x in recent_returns if x < 0)

    if ret_5d is None and bias_20d is None and ret_1d is None:
        return _dimension("missing", "neutral", {}, "price_trend_missing")
    if (ret_5d is not None and ret_5d <= -0.04) or (bias_20d is not None and bias_20d <= -0.06) or negative_sessions >= 4:
        return _dimension("available", "bearish", {
            "twii_return_1d": ret_1d,
            "twii_return_5d": ret_5d,
            "twii_bias_20d": bias_20d,
            "negative_sessions_5d": negative_sessions,
        }, "trend_breakdown")
    if (ret_5d is not None and ret_5d >= 0.035) and (bias_20d is None or bias_20d >= 0.015):
        return _dimension("available", "bullish", {
            "twii_return_1d": ret_1d,
            "twii_return_5d": ret_5d,
            "twii_bias_20d": bias_20d,
            "negative_sessions_5d": negative_sessions,
        }, "trend_positive")
    return _dimension("available", "neutral", {
        "twii_return_1d": ret_1d,
        "twii_return_5d": ret_5d,
        "twii_bias_20d": bias_20d,
        "negative_sessions_5d": negative_sessions,
    }, "trend_mixed")


def _breadth(market_env: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    advance_ratio = _normalize_ratio(_latest_value(market_env, rows, "advance_ratio"))
    bull_alignment = _normalize_ratio(_latest_value(market_env, rows, "bull_alignment_pct"))
    adl_trend = _latest_value(market_env, rows, "adl_trend_numeric")
    limit_down_pct = _latest_value(market_env, rows, "limit_down_pct")

    if advance_ratio is None and bull_alignment is None and adl_trend is None and limit_down_pct is None:
        return _dimension("missing", "neutral", {}, "breadth_missing")
    if (
        (advance_ratio is not None and advance_ratio <= 0.40)
        or (bull_alignment is not None and bull_alignment <= 0.35)
        or (adl_trend is not None and adl_trend < 0 and limit_down_pct is not None and limit_down_pct >= 0.005)
    ):
        return _dimension("available", "bearish", {
            "advance_ratio": advance_ratio,
            "bull_alignment_pct": bull_alignment,
            "adl_trend_numeric": adl_trend,
            "limit_down_pct": limit_down_pct,
        }, "breadth_deterioration")
    if (advance_ratio is not None and advance_ratio >= 0.58) and (bull_alignment is None or bull_alignment >= 0.55):
        return _dimension("available", "bullish", {
            "advance_ratio": advance_ratio,
            "bull_alignment_pct": bull_alignment,
            "adl_trend_numeric": adl_trend,
            "limit_down_pct": limit_down_pct,
        }, "breadth_confirmation")
    return _dimension("available", "neutral", {
        "advance_ratio": advance_ratio,
        "bull_alignment_pct": bull_alignment,
        "adl_trend_numeric": adl_trend,
        "limit_down_pct": limit_down_pct,
    }, "breadth_mixed")


def _atr_vturn(market_env: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    atr_pct = _latest_value(market_env, rows, "atr_pct")
    ret_1d = _latest_value(market_env, rows, "twii_return_1d")
    vix = _latest_value(market_env, rows, "us_vix")
    returns = [_to_float(row.get("market_return_1d")) for row in rows[-10:]]
    returns = [x for x in returns if x is not None]
    realized_vol = None
    if len(returns) >= 5:
        mean = sum(returns) / len(returns)
        realized_vol = math.sqrt(sum((x - mean) ** 2 for x in returns) / len(returns))
    vol_proxy = atr_pct if atr_pct is not None else realized_vol
    prior_two_down = len(returns) >= 3 and returns[-2] < 0 and returns[-3] < 0

    if vol_proxy is None and ret_1d is None and vix is None:
        return _dimension("missing", "neutral", {}, "atr_vturn_missing")
    if ret_1d is not None and ret_1d >= 0.018 and prior_two_down and (vol_proxy is None or vol_proxy >= 0.012):
        return _dimension("derived", "bullish", {
            "twii_return_1d": ret_1d,
            "atr_pct": atr_pct,
            "realized_vol_10d": realized_vol,
            "us_vix": vix,
        }, "vturn_rebound")
    if (
        ret_1d is not None
        and (
            (ret_1d <= -0.02 and vol_proxy is not None and vol_proxy >= 0.018)
            or (ret_1d <= -0.015 and vix is not None and vix >= 30)
        )
    ):
        return _dimension("derived", "bearish", {
            "twii_return_1d": ret_1d,
            "atr_pct": atr_pct,
            "realized_vol_10d": realized_vol,
            "us_vix": vix,
        }, "high_vol_breakdown")
    return _dimension("derived", "neutral", {
        "twii_return_1d": ret_1d,
        "atr_pct": atr_pct,
        "realized_vol_10d": realized_vol,
        "us_vix": vix,
    }, "no_vturn_signal")


def _leverage(market_env: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    margin_change_5d = _latest_value(market_env, rows, "margin_change_5d")
    maintenance_rate = _latest_value(market_env, rows, "margin_maintenance_rate")
    short_ratio = _latest_value(market_env, rows, "short_ratio")
    ret_5d = _latest_value(market_env, rows, "twii_return_5d")

    if margin_change_5d is None and maintenance_rate is None and short_ratio is None:
        return _dimension("missing", "neutral", {}, "leverage_missing")
    if (
        (margin_change_5d is not None and margin_change_5d >= 0.05 and ret_5d is not None and ret_5d < 0)
        or (maintenance_rate is not None and maintenance_rate >= 0.35)
    ):
        return _dimension("available", "bearish", {
            "margin_change_5d": margin_change_5d,
            "margin_maintenance_rate": maintenance_rate,
            "short_ratio": short_ratio,
        }, "leverage_stress")
    return _dimension("available", "neutral", {
        "margin_change_5d": margin_change_5d,
        "margin_maintenance_rate": maintenance_rate,
        "short_ratio": short_ratio,
    }, "leverage_neutral")


def _valuation(market_env: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    percentile = _latest_value(market_env, rows, "valuation_percentile")
    pe_percentile = _latest_value(market_env, rows, "market_pe_percentile")
    metric = percentile if percentile is not None else pe_percentile
    if metric is None:
        return _dimension("missing", "neutral", {}, "valuation_missing")
    metric = _normalize_ratio(metric)
    if metric is not None and metric >= 0.85:
        return _dimension("available", "bearish", {"valuation_percentile": metric}, "valuation_stretched")
    if metric is not None and metric <= 0.25:
        return _dimension("available", "bullish", {"valuation_percentile": metric}, "valuation_reset")
    return _dimension("available", "neutral", {"valuation_percentile": metric}, "valuation_mid")


def _macro_liquidity(market_env: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    m1b_yoy = _latest_value(market_env, rows, "m1b_yoy")
    m2_yoy = _latest_value(market_env, rows, "m2_yoy")
    business_score = _latest_value(market_env, rows, "business_indicator_score")
    pmi = _latest_value(market_env, rows, "pmi")
    fred_stress = _latest_value(market_env, rows, "fred_stress_score")

    if all(v is None for v in (m1b_yoy, m2_yoy, business_score, pmi, fred_stress)):
        return _dimension("missing", "neutral", {}, "macro_liquidity_missing")
    if (
        (m1b_yoy is not None and m1b_yoy < 0)
        or (m2_yoy is not None and m2_yoy < 0)
        or (business_score is not None and business_score <= -0.5)
        or (pmi is not None and pmi < 48)
        or (fred_stress is not None and fred_stress >= 0.7)
    ):
        return _dimension("available", "bearish", {
            "m1b_yoy": m1b_yoy,
            "m2_yoy": m2_yoy,
            "business_indicator_score": business_score,
            "pmi": pmi,
            "fred_stress_score": fred_stress,
        }, "macro_liquidity_contraction")
    return _dimension("available", "neutral", {
        "m1b_yoy": m1b_yoy,
        "m2_yoy": m2_yoy,
        "business_indicator_score": business_score,
        "pmi": pmi,
        "fred_stress_score": fred_stress,
    }, "macro_liquidity_mixed")


def _tw_business_indicators(market_env: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    signal = _latest_value(market_env, rows, "tw_business_signal")
    leading = _latest_value(market_env, rows, "tw_business_leading_index")
    coincident = _latest_value(market_env, rows, "tw_business_coincident_index")
    date = market_env.get("tw_business_signal_date")
    if not date:
        for row in reversed(rows):
            if row.get("tw_business_signal_date"):
                date = row.get("tw_business_signal_date")
                break

    if signal is None and leading is None and coincident is None:
        return _dimension("missing", "neutral", {}, "tw_business_indicators_missing")
    if signal is not None and signal <= 22:
        stance = "bearish"
        reason = "business_cycle_contraction"
    elif signal is not None and signal >= 32:
        stance = "bullish"
        reason = "business_cycle_expansion"
    else:
        stance = "neutral"
        reason = "business_cycle_mid"

    item = _dimension("available", stance, {
        "signal": signal,
        "leading_index": leading,
        "coincident_index": coincident,
    }, reason)
    item.update({
        "signal": signal,
        "leading_index": leading,
        "coincident_index": coincident,
        "date": str(date)[:10] if date else None,
        "source": "finlab.tw_business_indicators",
    })
    return item


def _global_risk(market_env: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    vix = _latest_value(market_env, rows, "us_vix")
    gspc = _latest_value(market_env, rows, "us_gspc_return")
    sox = _latest_value(market_env, rows, "us_sox_return")
    hy_chg = _latest_value(market_env, rows, "us_hy_spread_chg")
    world_index_5d = _latest_value(market_env, rows, "world_index_return_5d")

    if all(v is None for v in (vix, gspc, sox, hy_chg, world_index_5d)):
        return _dimension("missing", "neutral", {}, "global_risk_missing")
    if (
        (vix is not None and vix >= 30)
        or (gspc is not None and gspc <= -0.018)
        or (sox is not None and sox <= -0.03)
        or (hy_chg is not None and hy_chg >= 0.25)
        or (world_index_5d is not None and world_index_5d <= -0.04)
    ):
        return _dimension("available", "bearish", {
            "us_vix": vix,
            "us_gspc_return": gspc,
            "us_sox_return": sox,
            "us_hy_spread_chg": hy_chg,
            "world_index_return_5d": world_index_5d,
        }, "global_risk_off")
    if (vix is not None and vix <= 18) and (gspc is None or gspc >= 0) and (sox is None or sox >= 0):
        return _dimension("available", "bullish", {
            "us_vix": vix,
            "us_gspc_return": gspc,
            "us_sox_return": sox,
            "us_hy_spread_chg": hy_chg,
            "world_index_return_5d": world_index_5d,
        }, "global_risk_on")
    return _dimension("available", "neutral", {
        "us_vix": vix,
        "us_gspc_return": gspc,
        "us_sox_return": sox,
        "us_hy_spread_chg": hy_chg,
        "world_index_return_5d": world_index_5d,
    }, "global_risk_mixed")


def _monitors(market_env: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return build_regime_monitors(market_env)


def _normal_label(raw_label: str) -> str:
    text = str(raw_label or "").strip().lower()
    if text.startswith("bull"):
        return "bull_market"
    if text.startswith("bear"):
        return "bear_market"
    if text.startswith("volatile"):
        return "volatile"
    return "sideways"


def build_regime_evidence_pack(market_env: dict[str, Any], raw_label: str) -> dict[str, Any]:
    rows = _history_rows(market_env)
    raw = _normal_label(raw_label)
    evidence = {
        "price_trend": _price_trend(market_env, rows),
        "breadth": _breadth(market_env, rows),
        "atr_vturn": _atr_vturn(market_env, rows),
        "leverage": _leverage(market_env, rows),
        "valuation": _valuation(market_env, rows),
        "macro_liquidity": _macro_liquidity(market_env, rows),
        "tw_business_indicators": _tw_business_indicators(market_env, rows),
        "global_risk": _global_risk(market_env, rows),
    }
    bearish = sum(1 for item in evidence.values() if item["stance"] == "bearish")
    bullish = sum(1 for item in evidence.values() if item["stance"] == "bullish")
    available = sum(1 for item in evidence.values() if item["status"] != "missing")
    missing = [name for name, item in evidence.items() if item["status"] == "missing"]

    transition_guard = {
        "status": "not_required",
        "reason": "non_bear_transition",
        "min_bearish_dimensions": 3,
        "requires": ["price_trend", "breadth_or_global_risk", "volatility_or_leverage"],
    }
    effective = raw

    if raw == "bear_market":
        breadth_or_global = evidence["breadth"]["stance"] == "bearish" or evidence["global_risk"]["stance"] == "bearish"
        vol_or_leverage = evidence["atr_vturn"]["stance"] == "bearish" or evidence["leverage"]["stance"] == "bearish"
        confirmed = bearish >= 3 and breadth_or_global and vol_or_leverage
        transition_guard = {
            **transition_guard,
            "status": "confirmed" if confirmed else "blocked",
            "reason": "cross_evidence_confirmed" if confirmed else "insufficient_cross_evidence_for_bear",
            "bearish_dimensions": bearish,
            "breadth_or_global_confirmed": breadth_or_global,
            "volatility_or_leverage_confirmed": vol_or_leverage,
        }
        if not confirmed:
            effective = "volatile"
    elif raw == "bull_market" and bearish >= 3:
        transition_guard = {
            **transition_guard,
            "status": "warning",
            "reason": "bull_label_with_bearish_cross_evidence",
            "bearish_dimensions": bearish,
        }

    return {
        "schema_version": REGIME_EVIDENCE_SCHEMA_VERSION,
        "raw_label": raw,
        "effective_label": effective,
        "evidence": evidence,
        "support_counts": {
            "bearish": bearish,
            "bullish": bullish,
            "available": available,
            "missing": len(missing),
        },
        "missing_dimensions": missing,
        "transition_guard": transition_guard,
        "monitors": _monitors(market_env),
        "decision_policy": "bear_market_requires_cross_evidence_confirmation",
    }
