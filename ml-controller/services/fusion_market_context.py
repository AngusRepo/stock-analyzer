"""Point-in-time market context shared by Fusion training and serving."""
from __future__ import annotations

import json
import math
from datetime import date, timedelta
from typing import Any, Callable


MARKET_CONTEXT_SCHEMA_VERSION = "fusion-market-context-pit-v1"
MARKET_CONTEXT_FEATURE_NAMES = [
    "market_return_5d",
    "market_bias_20d",
    "market_risk_score_norm",
    "market_breadth_balance",
    "regime_bull_probability",
    "regime_defensive_probability",
    "market_context_available",
    "regime_surface_available",
    "l4_defensive_regime_interaction",
]
EXECUTION_MARKET_CONTEXT_FEATURE_NAMES = [
    "s12_defensive_regime_interaction",
]


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clip(value: Any, lower: float, upper: float) -> float | None:
    number = _float_or_none(value)
    if number is None:
        return None
    return max(lower, min(upper, number))


def _normalize_bias(value: Any) -> float | None:
    number = _float_or_none(value)
    if number is None:
        return None
    if abs(number) > 1.0:
        number /= 100.0
    return max(-0.50, min(0.50, number))


def _normalize_ratio(value: Any) -> float | None:
    number = _float_or_none(value)
    if number is None:
        return None
    if number > 1.0 and number <= 100.0:
        number /= 100.0
    return max(0.0, min(1.0, number))


def _normalize_surface(raw: Any) -> dict[str, float]:
    values = {"bull": 0.0, "bear": 0.0, "volatile": 0.0, "sideways": 0.0}
    if not isinstance(raw, dict):
        return values
    for key, value in raw.items():
        number = _float_or_none(value)
        if number is None or number < 0.0:
            continue
        normalized = str(key or "").strip().lower()
        if normalized.startswith("bull"):
            bucket = "bull"
        elif normalized.startswith("bear"):
            bucket = "bear"
        elif normalized.startswith("volatile") or normalized.startswith("crisis"):
            bucket = "volatile"
        elif normalized.startswith("sideway"):
            bucket = "sideways"
        else:
            continue
        values[bucket] += number
    total = sum(values.values())
    if total <= 0.0:
        return {key: 0.0 for key in values}
    return {key: round(value / total, 8) for key, value in values.items()}


def _dominant_regime(surface: dict[str, float]) -> str:
    if sum(surface.values()) <= 0.0:
        return "unclassified"
    return max(surface, key=lambda key: surface[key])


def _date_lte(left: Any, right: Any) -> bool:
    try:
        return date.fromisoformat(str(left)[:10]) <= date.fromisoformat(str(right)[:10])
    except (TypeError, ValueError):
        return False


def normalize_market_context(raw: Any, *, signal_date: str) -> dict[str, Any]:
    payload = _loads(raw)
    source_date = str(payload.get("source_date") or payload.get("as_of_date") or "")[:10]
    if source_date and not _date_lte(source_date, signal_date):
        return missing_market_context(signal_date, reason="market_context_source_after_signal_date")
    surface = _normalize_surface(payload.get("regime_surface"))
    market_return_1d = _clip(payload.get("market_return_1d"), -0.20, 0.20)
    market_return_5d = _clip(payload.get("market_return_5d"), -0.35, 0.35)
    market_bias_20d = _normalize_bias(payload.get("market_bias_20d"))
    risk_score = _clip(payload.get("risk_score"), 0.0, 100.0)
    advance_ratio = _normalize_ratio(payload.get("advance_ratio"))
    bull_alignment = _normalize_ratio(payload.get("bull_alignment_pct"))
    continuous_available = any(
        value is not None
        for value in (market_return_1d, market_return_5d, market_bias_20d, risk_score, advance_ratio)
    )
    surface_available = sum(surface.values()) > 0.0
    return {
        "schema_version": MARKET_CONTEXT_SCHEMA_VERSION,
        "signal_date": str(signal_date)[:10],
        "source_date": source_date or None,
        "source": str(payload.get("source") or "missing"),
        "market_segment": str(payload.get("market_segment") or "UNKNOWN"),
        "market_return_1d": market_return_1d,
        "market_return_5d": market_return_5d,
        "market_bias_20d": market_bias_20d,
        "risk_score": risk_score,
        "advance_ratio": advance_ratio,
        "bull_alignment_pct": bull_alignment,
        "regime_surface": surface,
        "regime_bucket": _dominant_regime(surface),
        "market_context_available": continuous_available,
        "regime_surface_available": surface_available,
        "point_in_time": bool(source_date and _date_lte(source_date, signal_date)),
        "reconstruction": str(payload.get("reconstruction") or "none"),
        "source_lineage": payload.get("source_lineage") if isinstance(payload.get("source_lineage"), dict) else {},
        "missing_reason": None if continuous_available or surface_available else str(payload.get("missing_reason") or "market_context_unavailable"),
    }


def missing_market_context(signal_date: str, *, reason: str) -> dict[str, Any]:
    return {
        "schema_version": MARKET_CONTEXT_SCHEMA_VERSION,
        "signal_date": str(signal_date)[:10],
        "source_date": None,
        "source": "missing",
        "market_segment": "UNKNOWN",
        "market_return_1d": None,
        "market_return_5d": None,
        "market_bias_20d": None,
        "risk_score": None,
        "advance_ratio": None,
        "bull_alignment_pct": None,
        "regime_surface": {"bull": 0.0, "bear": 0.0, "volatile": 0.0, "sideways": 0.0},
        "regime_bucket": "unclassified",
        "market_context_available": False,
        "regime_surface_available": False,
        "point_in_time": False,
        "reconstruction": "none",
        "source_lineage": {},
        "missing_reason": reason,
    }


def build_runtime_market_context(
    *,
    signal_date: str,
    market_env: dict[str, Any] | None,
    regime_label: str | None,
    regime_surface: dict[str, Any] | None,
    market_segment: str | None = None,
) -> dict[str, Any]:
    env = market_env if isinstance(market_env, dict) else {}
    history = env.get("history") if isinstance(env.get("history"), dict) else {}
    signal_day = str(signal_date)[:10]
    eligible_dates = sorted(
        value
        for value, row in history.items()
        if isinstance(row, dict) and _date_lte(value, signal_day)
    )
    history_source_date = eligible_dates[-1] if eligible_dates else None
    asof = dict(history.get(history_source_date) or {}) if history_source_date else {}
    surface = dict(regime_surface or {})
    if not surface and regime_label:
        surface = {regime_label: 1.0}
    return normalize_market_context({
        "source_date": history_source_date or signal_day,
        "source": "market_regime_state_plus_runtime_market_env_history",
        "market_segment": market_segment or "UNKNOWN",
        "market_return_1d": asof.get("market_return_1d"),
        "market_return_5d": asof.get("market_return_5d"),
        "market_bias_20d": asof.get("market_bias_20d"),
        "risk_score": asof.get("risk_score"),
        "advance_ratio": asof.get("advance_ratio"),
        "bull_alignment_pct": asof.get("bull_alignment_pct"),
        "regime_surface": surface,
        "reconstruction": "native_runtime",
        "source_lineage": {
            "market_env_history_source_date": history_source_date,
            "market_env_exact_date": history_source_date == signal_day,
            "future_rows_used": False,
            "regime_owner": "market_regime_state",
        },
    }, signal_date=signal_day)


def recorded_market_context(row: dict[str, Any], *, signal_date: str) -> dict[str, Any] | None:
    direct = row.get("market_regime_context")
    alpha_context = _loads(row.get("alpha_context"))
    nested = alpha_context.get("market_regime_context")
    if isinstance(direct, (dict, str)) and _loads(direct):
        return normalize_market_context(direct, signal_date=signal_date)
    if isinstance(nested, (dict, str)) and _loads(nested):
        return normalize_market_context(nested, signal_date=signal_date)
    surface = alpha_context.get("regime_surface")
    if isinstance(surface, dict) and surface:
        return normalize_market_context({
            "source_date": signal_date,
            "source": "recorded_alpha_context_regime_surface",
            "market_segment": row.get("market_segment"),
            "regime_surface": surface,
            "reconstruction": "recorded_native_surface",
        }, signal_date=signal_date)
    return None


def merge_market_context(
    recorded: dict[str, Any] | None,
    reconstructed: dict[str, Any] | None,
    *,
    signal_date: str,
) -> dict[str, Any]:
    if recorded is None and reconstructed is None:
        return missing_market_context(signal_date, reason="recorded_and_reconstructed_market_context_missing")
    left = normalize_market_context(recorded or {}, signal_date=signal_date)
    right = normalize_market_context(reconstructed or {}, signal_date=signal_date)
    raw: dict[str, Any] = {
        "source_date": right.get("source_date") or left.get("source_date"),
        "source": "+".join(value for value in (left.get("source"), right.get("source")) if value and value != "missing"),
        "market_segment": right.get("market_segment") or left.get("market_segment"),
        "reconstruction": right.get("reconstruction") or left.get("reconstruction"),
        "source_lineage": {
            "recorded": left.get("source_lineage") or {},
            "reconstructed": right.get("source_lineage") or {},
        },
    }
    for name in (
        "market_return_1d", "market_return_5d", "market_bias_20d", "risk_score",
        "advance_ratio", "bull_alignment_pct",
    ):
        raw[name] = right.get(name) if right.get(name) is not None else left.get(name)
    raw["regime_surface"] = (
        left.get("regime_surface")
        if left.get("regime_surface_available")
        else right.get("regime_surface")
    )
    return normalize_market_context(raw, signal_date=signal_date)


def _index_features(rows: list[dict[str, Any]], signal_date: str) -> dict[str, Any]:
    eligible = [row for row in rows if str(row.get("date") or "")[:10] <= signal_date and _float_or_none(row.get("close"))]
    if not eligible or str(eligible[-1].get("date") or "")[:10] != signal_date:
        return {}
    closes = [float(row["close"]) for row in eligible]
    current = closes[-1]
    return {
        "source_date": signal_date,
        "market_return_1d": (current / closes[-2]) - 1.0 if len(closes) >= 2 else None,
        "market_return_5d": (current / closes[-6]) - 1.0 if len(closes) >= 6 else None,
        "market_bias_20d": (current / (sum(closes[-20:]) / 20.0)) - 1.0 if len(closes) >= 20 else None,
        "index_source": eligible[-1].get("source"),
        "index_materialized_as_of_date": eligible[-1].get("as_of_date"),
    }


def load_pit_market_contexts(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    signal_dates: list[str],
) -> dict[tuple[str, str], dict[str, Any]]:
    dates = sorted({str(value)[:10] for value in signal_dates if str(value)[:10]})
    if not dates:
        return {}
    start = (date.fromisoformat(dates[0]) - timedelta(days=60)).isoformat()
    end = dates[-1]
    index_rows = query_fn(
        """
        SELECT symbol, date, close, source, as_of_date
        FROM canonical_market_index_daily
        WHERE symbol IN ('TWII','TWOII') AND date BETWEEN ? AND ? AND close > 0
        ORDER BY symbol, date,
                 CASE WHEN source LIKE 'finlab.%' THEN 0 ELSE 1 END,
                 source
        """,
        [start, end],
    )
    risk_rows = query_fn(
        """
        SELECT date, risk_score, twii_bias, twii_vol20
        FROM market_risk WHERE date BETWEEN ? AND ? ORDER BY date
        """,
        [start, end],
    )
    breadth_rows = query_fn(
        """
        SELECT date, advance_ratio, bull_alignment_pct
        FROM market_breadth WHERE date BETWEEN ? AND ? ORDER BY date
        """,
        [start, end],
    )
    by_symbol: dict[str, list[dict[str, Any]]] = {"TWII": [], "TWOII": []}
    seen_index: set[tuple[str, str]] = set()
    for row in index_rows or []:
        key = (str(row.get("symbol") or ""), str(row.get("date") or "")[:10])
        if key in seen_index or key[0] not in by_symbol:
            continue
        seen_index.add(key)
        by_symbol[key[0]].append(dict(row))
    risk_by_date = {str(row.get("date") or "")[:10]: dict(row) for row in risk_rows or []}
    breadth_by_date = {str(row.get("date") or "")[:10]: dict(row) for row in breadth_rows or []}
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for signal_date in dates:
        risk_dates = [value for value in risk_by_date if value <= signal_date]
        breadth_dates = [value for value in breadth_by_date if value <= signal_date]
        risk = risk_by_date[max(risk_dates)] if risk_dates else {}
        breadth = breadth_by_date[max(breadth_dates)] if breadth_dates else {}
        for segment, symbol in (("LISTED", "TWII"), ("OTC", "TWOII")):
            index = _index_features(by_symbol[symbol], signal_date)
            source_dates = [
                str(value)[:10]
                for value in (index.get("source_date"), risk.get("date"), breadth.get("date"))
                if value and str(value)[:10] <= signal_date
            ]
            reconstructed = {
                **index,
                "source_date": max(source_dates) if source_dates else None,
                "source": "canonical_market_pit_counterfactual_reconstruction",
                "market_segment": segment,
                "risk_score": risk.get("risk_score"),
                "market_bias_20d": (
                    index.get("market_bias_20d")
                    if index.get("market_bias_20d") is not None
                    else risk.get("twii_bias")
                ),
                "advance_ratio": breadth.get("advance_ratio"),
                "bull_alignment_pct": breadth.get("bull_alignment_pct"),
                "regime_surface": {},
                "reconstruction": "public_market_facts_asof_signal_date",
                "source_lineage": {
                    "index_symbol": symbol,
                    "index_source": index.get("index_source"),
                    "index_materialized_as_of_date": index.get("index_materialized_as_of_date"),
                    "risk_source_date": risk.get("date"),
                    "breadth_source_date": breadth.get("date"),
                    "future_rows_used": False,
                },
            }
            out[(signal_date, segment)] = normalize_market_context(reconstructed, signal_date=signal_date)
    return out


def context_for_market_segment(
    contexts: dict[tuple[str, str], dict[str, Any]],
    *,
    signal_date: str,
    market_segment: Any,
) -> dict[str, Any] | None:
    text = str(market_segment or "").strip().upper()
    segment = "OTC" if any(token in text for token in ("OTC", "TPEX", "TWOII")) else "LISTED"
    return contexts.get((str(signal_date)[:10], segment))


def market_context_feature_values(
    row: dict[str, Any],
    *,
    l4_value: float | None,
    s12_value: float | None,
) -> dict[str, float]:
    signal_date = str(row.get("prediction_date") or row.get("snapshot_date") or row.get("date") or "")[:10]
    context = recorded_market_context(row, signal_date=signal_date) or missing_market_context(
        signal_date,
        reason="market_context_missing_from_feature_row",
    )
    surface = context["regime_surface"]
    defensive = float(surface.get("bear") or 0.0) + float(surface.get("volatile") or 0.0)
    advance_ratio = _float_or_none(context.get("advance_ratio"))
    return {
        "market_return_5d": float(context.get("market_return_5d") or 0.0),
        "market_bias_20d": float(context.get("market_bias_20d") or 0.0),
        "market_risk_score_norm": float(context.get("risk_score") or 0.0) / 100.0,
        "market_breadth_balance": ((advance_ratio - 0.5) * 2.0) if advance_ratio is not None else 0.0,
        "regime_bull_probability": float(surface.get("bull") or 0.0),
        "regime_defensive_probability": defensive,
        "market_context_available": 1.0 if context.get("market_context_available") else 0.0,
        "regime_surface_available": 1.0 if context.get("regime_surface_available") else 0.0,
        "l4_defensive_regime_interaction": float(l4_value or 0.0) * defensive,
        "s12_defensive_regime_interaction": float(s12_value or 0.0) * defensive,
    }


def market_regime_bucket(row: dict[str, Any]) -> str:
    signal_date = str(row.get("prediction_date") or row.get("snapshot_date") or row.get("date") or "")[:10]
    context = recorded_market_context(row, signal_date=signal_date)
    return str((context or {}).get("regime_bucket") or "unclassified")
