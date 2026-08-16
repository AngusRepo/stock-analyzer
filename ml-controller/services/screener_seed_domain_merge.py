"""Pure OPS/Core screener-seed merge used for cutover equivalence checks."""
from __future__ import annotations

import json
from typing import Any


EMERGING_SEGMENTS = {"EMERGING", "ESB", "ROTC"}
TRADABLE_MARKETS = {"TWSE", "TSE", "LISTED", "OTC", "TPEX"}


def _coalesce(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _json_extract_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return value


def _sort_number(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def merge_screener_seed_domains(
    *,
    ops_seed_rows: list[dict[str, Any]],
    daily_rows: list[dict[str, Any]],
    stock_rows: list[dict[str, Any]],
    run_date: str,
) -> list[dict[str, Any]]:
    """Reproduce the legacy cross-domain SQL result without cross-database joins."""
    daily_by_symbol = {
        str(row.get("symbol") or "").strip(): row
        for row in daily_rows
        if str(row.get("symbol") or "").strip()
    }
    stock_by_symbol = {
        str(row.get("symbol") or "").strip(): row
        for row in stock_rows
        if str(row.get("symbol") or "").strip()
    }
    merged: list[dict[str, Any]] = []

    for seed in ops_seed_rows:
        symbol = str(seed.get("symbol") or "").strip()
        if not symbol:
            continue
        daily = daily_by_symbol.get(symbol, {})
        stock = stock_by_symbol.get(symbol, {})
        stock_id = _coalesce(daily.get("stock_id"), stock.get("stock_id"))
        if stock_id is None:
            continue

        seed_evidence = _json_object(seed.get("seed_evidence"))
        scoring_evidence = _json_object(seed.get("scoring_evidence"))
        l1_evidence = _json_object(seed.get("l1_evidence"))
        taxonomy = scoring_evidence.get("taxonomy")
        taxonomy = taxonomy if isinstance(taxonomy, dict) else {}
        market_segment = _coalesce(
            daily.get("market_segment"),
            seed_evidence.get("market_segment"),
            l1_evidence.get("market_segment"),
            stock.get("market"),
            "LISTED",
        )
        stock_market = str(stock.get("market") or "").upper()
        default_lane = (
            "tradable"
            if stock_market in TRADABLE_MARKETS
            else "emerging_watchlist"
            if stock_market in EMERGING_SEGMENTS
            else "research_only"
        )
        recommendation_lane = _coalesce(daily.get("recommendation_lane"), default_lane)
        if recommendation_lane == "emerging_watchlist":
            continue
        if str(market_segment or "").upper() in EMERGING_SEGMENTS:
            continue

        merged.append({
            "id": daily.get("id"),
            "screener_run_id": seed.get("screener_run_id"),
            "decision_universe_frozen_at": seed.get("decision_universe_frozen_at"),
            "date": run_date,
            "stock_id": stock_id,
            "symbol": symbol,
            "name": _coalesce(daily.get("name"), seed.get("seed_name"), stock.get("name"), symbol),
            "sector": _coalesce(daily.get("sector"), stock.get("sector")),
            "industry": _coalesce(
                daily.get("industry"),
                taxonomy.get("industry"),
                l1_evidence.get("industry"),
                stock.get("sector"),
            ),
            "rank": _coalesce(seed.get("seed_rank"), daily.get("rank"), 999999),
            "score": _coalesce(seed.get("seed_score"), daily.get("score"), seed.get("scoring_score"), 0),
            "signal": daily.get("signal"),
            "confidence": daily.get("confidence"),
            "reason": _coalesce(
                daily.get("reason"),
                l1_evidence.get("strategy_pool_reason"),
                seed.get("seed_reason_code"),
                "screener candidate seed",
            ),
            "watch_points": _coalesce(
                daily.get("watch_points"),
                json.dumps(
                    [
                        f"screener_seed:{seed.get('seed_stage')}",
                        f"screener_run:{seed.get('screener_run_id')}",
                    ],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            ),
            "has_buy_signal": _coalesce(daily.get("has_buy_signal"), 0),
            "current_price": daily.get("current_price"),
            "foreign_net_5d": daily.get("foreign_net_5d"),
            "trust_net_5d": daily.get("trust_net_5d"),
            "rsi14": daily.get("rsi14"),
            "macd_hist": daily.get("macd_hist"),
            "sector_rank": daily.get("sector_rank"),
            "market_segment": market_segment,
            "recommendation_lane": recommendation_lane,
            "eligible_for_ml": _coalesce(daily.get("eligible_for_ml"), 1),
            "eligible_for_pending_buy": _coalesce(daily.get("eligible_for_pending_buy"), 0),
            "alpha_context": daily.get("alpha_context"),
            "alpha_allocation": daily.get("alpha_allocation"),
            "ml_vote_summary": daily.get("ml_vote_summary"),
            "score_components": _json_extract_value(
                _coalesce(scoring_evidence.get("score_components"), daily.get("score_components"))
            ),
        })

    return sorted(
        merged,
        key=lambda row: (
            _sort_number(row.get("rank"), 999999),
            -_sort_number(row.get("score"), 0),
        ),
    )
