"""Production owner utilities for historical portfolio-allocation replacement.

The dry-run benchmark can say a replacement is better. This module owns the
next step: replay historical daily recommendations, decide whether sparse
tangent allocation beats the current rank owner, and, when explicitly confirmed,
activate that owner in production trading:config.
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from datetime import datetime, timedelta
import json
import math
from typing import Any

from services.portfolio_allocation import (
    allocate_rank_topk_equal_weight,
    allocate_sparse_tangent,
    portfolio_metrics,
)


SCHEMA_VERSION = "portfolio-allocation-production-replacement-v1"
SPARSE_TANGENT_METHOD = "sparse_tangent_inverse_risk"


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if is_dataclass(value):
        return asdict(value)
    return {}


def _json_record(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _symbol(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or "").strip()


def _score(row: dict[str, Any]) -> float:
    alpha_agent_evo_score = row.get("alpha_agent_evo_score")
    if alpha_agent_evo_score is None:
        allocation = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
        alpha_agent_evo_score = allocation.get("alpha_agent_evo_score")
    if alpha_agent_evo_score is not None:
        return _to_float(alpha_agent_evo_score)
    score_components = _json_record(row.get("score_components"))
    if score_components:
        score = score_components.get("finalScore", score_components.get("total"))
        if score is not None:
            return _to_float(score)
    return _to_float(row.get("score"))


def _forecast_pct(row: dict[str, Any]) -> float:
    for key in ("expected_return", "predicted_return", "forecast_pct", "ml_forecast_pct"):
        if row.get(key) is not None:
            return _to_float(row.get(key))
    forecast_data = _json_record(row.get("forecast_data"))
    for key in ("forecast_pct", "ml_forecast_pct", "expected_return", "predicted_return"):
        if forecast_data.get(key) is not None:
            return _to_float(forecast_data.get(key))
    return max(0.0, (_score(row) - 50.0) / 5000.0)


def _candidate(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    out["score"] = _score(row)
    out["expected_return"] = _forecast_pct(row)
    return out


def _daily_returns_from_prices(prices: list[float]) -> list[float]:
    returns: list[float] = []
    for prev, current in zip(prices, prices[1:]):
        if prev > 0 and current > 0:
            returns.append((current - prev) / prev)
    return returns


def return_history_from_payloads(payloads: list[Any], lookback_days: int = 60) -> dict[str, list[float]]:
    histories: dict[str, list[float]] = {}
    for payload in payloads or []:
        row = _as_mapping(payload)
        symbol = _symbol(row)
        if not symbol:
            continue
        prices = row.get("prices") or []
        closes = [
            _to_float(item.get("close"))
            for item in prices
            if isinstance(item, dict) and _to_float(item.get("close")) > 0
        ]
        histories[symbol] = _daily_returns_from_prices(closes)[-max(1, int(lookback_days)):]
    return histories


def _sparse_tangent_weights(
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    *,
    top_k: int,
    max_weight: float,
    selection_pool_size: int,
) -> dict[str, float]:
    return allocate_sparse_tangent(
        [_candidate(row) for row in candidates],
        return_history,
        top_k=top_k,
        max_weight=max_weight,
        selection_pool_size=selection_pool_size,
    )


def apply_sparse_tangent_production_allocation(
    recommendations: list[dict[str, Any]],
    payloads: list[Any],
    *,
    top_k: int,
    max_weight: float = 0.55,
    selection_pool_size: int | None = None,
    min_history_days: int = 20,
    confidence_floor: float = 0.72,
    enforce_buy_signal_owner: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Mutate recommendation rows so sparse tangent owns final BUY selection."""
    if not recommendations:
        return recommendations, {"status": "skipped", "reason": "empty_recommendations"}

    top_k = max(1, int(top_k))
    selection_pool_size = max(top_k, int(selection_pool_size or top_k * 4))
    return_history = return_history_from_payloads(payloads)
    eligible_rows = [
        row for row in recommendations
        if _symbol(row) and len(return_history.get(_symbol(row), [])) >= max(1, int(min_history_days))
    ]
    usable_days = min((len(return_history.get(_symbol(row), [])) for row in eligible_rows), default=0)
    if len(eligible_rows) < top_k:
        return recommendations, {
            "status": "skipped",
            "reason": "insufficient_return_history",
            "usable_history_days": usable_days,
            "min_history_days": max(1, int(min_history_days)),
            "eligible_symbols": len(eligible_rows),
            "top_k": top_k,
        }

    weights = _sparse_tangent_weights(
        eligible_rows,
        return_history,
        top_k=top_k,
        max_weight=max_weight,
        selection_pool_size=selection_pool_size,
    )
    if not weights:
        return recommendations, {"status": "skipped", "reason": "empty_sparse_tangent_weights"}

    selected_symbols = set(weights)
    equal_weight = 1.0 / max(1, len(weights))
    selected_order = {
        symbol: idx + 1
        for idx, symbol in enumerate(sorted(weights, key=lambda sym: weights[sym], reverse=True))
    }

    selected: list[dict[str, Any]] = []
    tail: list[dict[str, Any]] = []
    for row in recommendations:
        symbol = _symbol(row)
        allocation = dict(row.get("alpha_allocation") or {})
        if symbol in selected_symbols:
            rank = selected_order[symbol]
            weight = float(weights[symbol])
            row["allocation_replaced_signal"] = {
                "signal": row.get("signal"),
                "signal_source": row.get("signal_source"),
                "has_buy_signal": row.get("has_buy_signal"),
            }
            row["signal"] = "BUY"
            row["signal_source"] = SPARSE_TANGENT_METHOD
            row["has_buy_signal"] = 1
            row["confidence"] = max(_to_float(row.get("confidence")), float(confidence_floor))
            row["rank"] = rank
            row["alpha_allocation"] = {
                **allocation,
                "selected": True,
                "selection_rank": rank,
                "method": SPARSE_TANGENT_METHOD,
                "owner": "portfolio_allocation",
                "portfolio_weight": round(weight, 8),
                "equal_weight_baseline": round(equal_weight, 8),
                "risk_pct_multiplier": round(max(0.25, min(1.75, weight / equal_weight)), 8),
                "selection_pool_size": selection_pool_size,
                "max_weight": max_weight,
                "historical_return_days": usable_days,
            }
            selected.append(row)
        else:
            if enforce_buy_signal_owner:
                row["has_buy_signal"] = 0
            row["alpha_allocation"] = {
                **allocation,
                "selected": False,
                "method": SPARSE_TANGENT_METHOD,
                "owner": "portfolio_allocation",
                "portfolio_weight": 0.0,
                "selection_pool_size": selection_pool_size,
                "historical_return_days": usable_days,
            }
            tail.append(row)

    tail = sorted(tail, key=_score, reverse=True)
    for idx, row in enumerate(tail, start=len(selected) + 1):
        row["rank"] = idx
    ordered = sorted(selected, key=lambda row: row["alpha_allocation"]["selection_rank"]) + tail
    return ordered, {
        "status": "production_owner_applied",
        "method": SPARSE_TANGENT_METHOD,
        "selected_symbols": list(selected_order),
        "weights": weights,
        "usable_history_days": usable_days,
        "top_k": top_k,
        "selection_pool_size": selection_pool_size,
        "enforce_buy_signal_owner": enforce_buy_signal_owner,
    }


def _price_panel(price_rows: list[dict[str, Any]]) -> dict[str, list[tuple[str, float]]]:
    panel: dict[str, list[tuple[str, float]]] = {}
    for row in price_rows:
        symbol = _symbol(row)
        date = str(row.get("date") or "").strip()[:10]
        close = _to_float(row.get("close"))
        if symbol and date and close > 0:
            panel.setdefault(symbol, []).append((date, close))
    for symbol in panel:
        panel[symbol] = sorted(panel[symbol], key=lambda item: item[0])
    return panel


def _history_for_symbol(panel: dict[str, list[tuple[str, float]]], symbol: str, date: str, lookback_days: int) -> list[float]:
    closes = [close for dt, close in panel.get(symbol, []) if dt <= date]
    return _daily_returns_from_prices(closes)[-max(1, int(lookback_days)):]


def _next_return(panel: dict[str, list[tuple[str, float]]], symbol: str, date: str) -> float | None:
    rows = panel.get(symbol, [])
    current = next((close for dt, close in reversed(rows) if dt <= date), None)
    future = next((close for dt, close in rows if dt > date), None)
    if current is None or future is None or current <= 0:
        return None
    return (future - current) / current


def build_historical_replacement_report(
    *,
    recommendation_rows: list[dict[str, Any]],
    price_rows: list[dict[str, Any]],
    start_date: str,
    end_date: str,
    top_k: int = 3,
    selection_pool_size: int = 30,
    lookback_days: int = 60,
    max_weight: float = 0.55,
    min_history_days: int = 20,
    min_sharpe_delta: float = 0.20,
    max_mdd_delta: float = 0.02,
) -> dict[str, Any]:
    panel = _price_panel(price_rows)
    by_date: dict[str, list[dict[str, Any]]] = {}
    for row in recommendation_rows:
        date = str(row.get("date") or "").strip()[:10]
        symbol = _symbol(row)
        if date and symbol:
            by_date.setdefault(date, []).append(_candidate(row))

    baseline_returns: list[float] = []
    replacement_returns: list[float] = []
    evaluated_dates: list[str] = []
    skipped_dates: list[dict[str, str]] = []
    top_k = max(1, int(top_k))
    selection_pool_size = max(top_k, int(selection_pool_size))

    for date in sorted(dt for dt in by_date if start_date <= dt <= end_date):
        candidates = sorted(by_date[date], key=_score, reverse=True)
        if len(candidates) < top_k:
            skipped_dates.append({"date": date, "reason": "insufficient_candidates"})
            continue
        return_history = {
            _symbol(row): _history_for_symbol(panel, _symbol(row), date, lookback_days)
            for row in candidates
            if _symbol(row)
        }
        eligible_candidates = [
            row for row in candidates
            if len(return_history.get(_symbol(row), [])) >= min_history_days
        ]
        if len(eligible_candidates) < top_k:
            skipped_dates.append({"date": date, "reason": "insufficient_return_history"})
            continue
        realized = {
            _symbol(row): _next_return(panel, _symbol(row), date)
            for row in eligible_candidates
            if _symbol(row)
        }
        realized = {symbol: value for symbol, value in realized.items() if value is not None}
        baseline_weights = allocate_rank_topk_equal_weight(eligible_candidates, top_k=top_k)
        replacement_weights = _sparse_tangent_weights(
            eligible_candidates,
            return_history,
            top_k=top_k,
            max_weight=max_weight,
            selection_pool_size=selection_pool_size,
        )
        if not baseline_weights or not replacement_weights:
            skipped_dates.append({"date": date, "reason": "empty_weights"})
            continue
        if not set(baseline_weights).issubset(realized) or not set(replacement_weights).issubset(realized):
            skipped_dates.append({"date": date, "reason": "missing_next_return"})
            continue
        baseline_returns.append(sum(weight * float(realized[symbol]) for symbol, weight in baseline_weights.items()))
        replacement_returns.append(sum(weight * float(realized[symbol]) for symbol, weight in replacement_weights.items()))
        evaluated_dates.append(date)

    baseline_metrics = portfolio_metrics(baseline_returns)
    replacement_metrics = portfolio_metrics(replacement_returns)
    sharpe_delta = None
    if baseline_metrics.get("sharpe") is not None and replacement_metrics.get("sharpe") is not None:
        sharpe_delta = round(float(replacement_metrics["sharpe"]) - float(baseline_metrics["sharpe"]), 8)
    max_drawdown_delta = None
    if baseline_metrics.get("max_drawdown") is not None and replacement_metrics.get("max_drawdown") is not None:
        max_drawdown_delta = round(float(replacement_metrics["max_drawdown"]) - float(baseline_metrics["max_drawdown"]), 8)

    eligible = (
        len(evaluated_dates) >= min_history_days
        and sharpe_delta is not None
        and max_drawdown_delta is not None
        and sharpe_delta >= min_sharpe_delta
        and max_drawdown_delta <= max_mdd_delta
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": f"portfolio-allocation-replacement:{start_date}:{end_date}",
        "date_range": {"start_date": start_date, "end_date": end_date},
        "baseline": {
            "owner": "rank_score_topk_equal_weight",
            "metrics": baseline_metrics,
        },
        "replacement": {
            "owner": SPARSE_TANGENT_METHOD,
            "metrics": replacement_metrics,
            "selection_pool_size": selection_pool_size,
            "top_k": top_k,
            "max_weight": max_weight,
        },
        "decision": {
            "replace_production_owner": eligible,
            "production_owner": SPARSE_TANGENT_METHOD if eligible else "rank_score_topk_equal_weight",
            "sharpe_delta": sharpe_delta,
            "max_drawdown_delta": max_drawdown_delta,
            "historical_replay_days": len(evaluated_dates),
            "min_history_days": min_history_days,
            "min_sharpe_delta": min_sharpe_delta,
            "max_mdd_delta": max_mdd_delta,
            "blockers": [] if eligible else [
                reason
                for reason, blocked in {
                    "insufficient_historical_days": len(evaluated_dates) < min_history_days,
                    "sharpe_delta_below_gate": sharpe_delta is None or sharpe_delta < min_sharpe_delta,
                    "max_drawdown_delta_above_gate": max_drawdown_delta is None or max_drawdown_delta > max_mdd_delta,
                }.items()
                if blocked
            ],
        },
        "evidence": {
            "evaluated_dates": evaluated_dates,
            "skipped_dates_sample": skipped_dates[:10],
            "recommendation_rows": len(recommendation_rows),
            "price_rows": len(price_rows),
        },
    }


def _start_for_price_window(start_date: str, lookback_days: int) -> str:
    return (datetime.fromisoformat(start_date[:10]) - timedelta(days=max(lookback_days * 3, lookback_days + 30))).strftime("%Y-%m-%d")


def _chunked_symbol_price_rows(symbols: list[str], start_date: str, end_date: str) -> list[dict[str, Any]]:
    from services import d1_client

    rows: list[dict[str, Any]] = []
    for idx in range(0, len(symbols), 80):
        chunk = symbols[idx: idx + 80]
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(d1_client.query(
            f"""
            SELECT s.symbol, sp.date, sp.close
              FROM stock_prices sp
              JOIN stocks s ON s.id = sp.stock_id
             WHERE s.symbol IN ({placeholders})
               AND sp.date BETWEEN ? AND ?
             ORDER BY s.symbol, sp.date
            """,
            [*chunk, start_date, end_date],
            timeout=120,
        ))
    return rows


def load_historical_replacement_inputs(
    *,
    start_date: str,
    end_date: str,
    lookback_days: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from services import d1_client

    recommendation_rows = d1_client.query(
        """
        SELECT dr.date, dr.symbol, dr.rank, dr.score, dr.confidence, dr.signal,
               dr.has_buy_signal, dr.score_components, dr.alpha_context,
               p.forecast_data
          FROM daily_recommendations dr
          LEFT JOIN stocks s ON s.symbol = dr.symbol
          LEFT JOIN predictions p ON p.id = (
            SELECT p2.id
              FROM predictions p2
             WHERE p2.stock_id = s.id
               AND p2.model_name = 'ensemble'
               AND p2.prediction_date = dr.date
             ORDER BY p2.generated_at DESC, p2.id DESC
             LIMIT 1
          )
         WHERE dr.date BETWEEN ? AND ?
         ORDER BY dr.date, dr.rank
        """,
        [start_date, end_date],
        timeout=120,
    )
    symbols = sorted({_symbol(row) for row in recommendation_rows if _symbol(row)})
    price_rows = _chunked_symbol_price_rows(
        symbols,
        _start_for_price_window(start_date, lookback_days),
        (datetime.fromisoformat(end_date[:10]) + timedelta(days=14)).strftime("%Y-%m-%d"),
    )
    return recommendation_rows, price_rows


def run_historical_replacement_report(
    *,
    start_date: str,
    end_date: str,
    top_k: int = 3,
    selection_pool_size: int = 30,
    lookback_days: int = 60,
    max_weight: float = 0.55,
    min_history_days: int = 20,
    min_sharpe_delta: float = 0.20,
    max_mdd_delta: float = 0.02,
) -> dict[str, Any]:
    recommendation_rows, price_rows = load_historical_replacement_inputs(
        start_date=start_date,
        end_date=end_date,
        lookback_days=lookback_days,
    )
    return build_historical_replacement_report(
        recommendation_rows=recommendation_rows,
        price_rows=price_rows,
        start_date=start_date,
        end_date=end_date,
        top_k=top_k,
        selection_pool_size=selection_pool_size,
        lookback_days=lookback_days,
        max_weight=max_weight,
        min_history_days=min_history_days,
        min_sharpe_delta=min_sharpe_delta,
        max_mdd_delta=max_mdd_delta,
    )


async def activate_sparse_tangent_owner(
    *,
    report: dict[str, Any],
    top_k: int,
    selection_pool_size: int,
    max_weight: float,
    min_history_days: int,
) -> dict[str, Any]:
    from services.worker_config_client import worker_fetch

    if not (report.get("decision") or {}).get("replace_production_owner"):
        return {"status": "blocked", "reason": "replacement_gate_not_passed"}

    body = {
        "alphaFramework": {
            "allocation": {
                "method": SPARSE_TANGENT_METHOD,
                "owner": "portfolio_allocation",
                "topK": max(1, int(top_k)),
                "selectionPoolSize": max(int(top_k), int(selection_pool_size)),
                "maxWeight": max_weight,
                "minHistoryDays": max(1, int(min_history_days)),
                "enforceBuySignalOwner": True,
                "activatedBy": "historical_replay_replacement",
                "activationRunId": report.get("run_id"),
            },
        },
        "override_reason": "historical replay replacement passed",
    }
    return await worker_fetch(
        "/api/admin/config",
        method="PUT",
        json_body=body,
        headers={"X-Confirm-Production-Override": "true"},
        timeout=45.0,
    )
