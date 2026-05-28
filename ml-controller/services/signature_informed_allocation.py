"""Signature-informed direct allocation utilities.

This is a production-compatible allocation arm, not a trained PyTorch runner.
It implements the deployable core of the Signature-Informed Transformer idea:
path-signature style return-path features, cross-asset lead-lag attention, and
tail-risk-aware direct portfolio weights. A future neural SIT model can replace
the scoring internals while keeping this same allocation contract.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import json
import math
import statistics
from typing import Any

from services.portfolio_allocation import (
    allocate_rank_topk_equal_weight,
    allocate_sparse_tangent,
    portfolio_metrics,
)


SCHEMA_VERSION = "signature-informed-allocation-v1"
SIT_METHOD = "signature_informed_transformer_direct_allocation"


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


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
    if row.get("alpha_agent_evo_score") is not None:
        return _to_float(row.get("alpha_agent_evo_score"))
    allocation = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
    if allocation.get("alpha_agent_evo_score") is not None:
        return _to_float(allocation.get("alpha_agent_evo_score"))
    score_components = _json_record(row.get("score_components"))
    if score_components:
        score = score_components.get("finalScore", score_components.get("total"))
        if score is not None:
            return _to_float(score)
    return _to_float(row.get("score"))


def _expected_return(row: dict[str, Any]) -> float:
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
    out["expected_return"] = _expected_return(row)
    return out


def _ranked_candidates(candidates: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    return sorted(
        [row for row in candidates if _symbol(row)],
        key=lambda row: (_score(row), _expected_return(row), _to_float(row.get("confidence"))),
        reverse=True,
    )[: max(1, int(limit))]


def _daily_returns_from_prices(prices: list[float]) -> list[float]:
    returns: list[float] = []
    for prev, current in zip(prices, prices[1:]):
        if prev > 0 and current > 0:
            returns.append((current - prev) / prev)
    return returns


def return_history_from_payloads(payloads: list[Any], lookback_days: int = 60) -> dict[str, list[float]]:
    histories: dict[str, list[float]] = {}
    for payload in payloads or []:
        if not isinstance(payload, dict):
            continue
        symbol = _symbol(payload)
        prices = payload.get("prices") or []
        closes = [
            _to_float(item.get("close"))
            for item in prices
            if isinstance(item, dict) and _to_float(item.get("close")) > 0
        ]
        if symbol:
            histories[symbol] = _daily_returns_from_prices(closes)[-max(1, int(lookback_days)):]
    return histories


def _sample_stdev(values: list[float]) -> float:
    return statistics.stdev(values) if len(values) >= 2 else 0.0


def _max_drawdown(returns: list[float]) -> float:
    equity = 1.0
    peak = 1.0
    mdd = 0.0
    for ret in returns:
        equity *= 1.0 + ret
        peak = max(peak, equity)
        if peak > 0:
            mdd = max(mdd, (peak - equity) / peak)
    return mdd


def _cvar_loss(returns: list[float], alpha: float = 0.20) -> float:
    if not returns:
        return 0.0
    n = max(1, int(math.ceil(len(returns) * max(0.01, min(0.50, alpha)))))
    worst = sorted(returns)[:n]
    return max(0.0, -sum(worst) / len(worst))


def _recency_weighted_return(returns: list[float]) -> float:
    if not returns:
        return 0.0
    denom = len(returns) * (len(returns) + 1) / 2
    return sum((idx + 1) * ret for idx, ret in enumerate(returns)) / denom


def _cumulative_path(returns: list[float]) -> list[float]:
    total = 0.0
    out: list[float] = []
    for ret in returns:
        total += ret
        out.append(total)
    return out


def _signed_area(left_returns: list[float], right_returns: list[float]) -> float:
    n = min(len(left_returns), len(right_returns))
    if n < 2:
        return 0.0
    x = _cumulative_path(left_returns[-n:])
    y = _cumulative_path(right_returns[-n:])
    area = 0.0
    for idx in range(1, n):
        dx = x[idx] - x[idx - 1]
        dy = y[idx] - y[idx - 1]
        area += 0.5 * (x[idx - 1] * dy - y[idx - 1] * dx)
    scale = max(1e-9, sum(abs(v) for v in left_returns[-n:]) * sum(abs(v) for v in right_returns[-n:]))
    return max(-1.0, min(1.0, area / scale))


def _signature_embedding(returns: list[float]) -> dict[str, Any]:
    if not returns:
        return {
            "vector": [0.0] * 6,
            "trend": 0.0,
            "recency": 0.0,
            "volatility": 0.0,
            "cvar_loss": 0.0,
            "max_drawdown": 0.0,
        }
    trend = sum(returns)
    variation = sum(abs(ret) for ret in returns)
    volatility = _sample_stdev(returns)
    cvar_loss = _cvar_loss(returns)
    max_drawdown = _max_drawdown(returns)
    recency = _recency_weighted_return(returns)
    positive_ratio = sum(1 for ret in returns if ret > 0) / len(returns)
    vector = [
        trend,
        recency * 10.0,
        variation,
        volatility * 10.0,
        cvar_loss * 10.0,
        positive_ratio - 0.5,
    ]
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return {
        "vector": [value / norm for value in vector],
        "trend": trend,
        "recency": recency,
        "volatility": volatility,
        "cvar_loss": cvar_loss,
        "max_drawdown": max_drawdown,
        "positive_ratio": positive_ratio,
    }


def _dot(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _softmax(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    center = max(scores.values())
    exp = {key: math.exp(max(-40.0, min(40.0, value - center))) for key, value in scores.items()}
    total = sum(exp.values()) or 1.0
    return {key: value / total for key, value in exp.items()}


def _cap_and_renormalize(raw: dict[str, float], *, max_weight: float) -> dict[str, float]:
    cleaned = {symbol: max(0.0, weight) for symbol, weight in raw.items() if symbol and weight > 0}
    if not cleaned:
        return {}
    cap = max(1e-6, min(1.0, float(max_weight)))
    weights = {symbol: weight / sum(cleaned.values()) for symbol, weight in cleaned.items()}
    capped: dict[str, float] = {}
    remaining = dict(weights)
    budget = 1.0
    while remaining and budget > 1e-9:
        total = sum(remaining.values())
        changed = False
        for symbol in list(remaining):
            weight = budget * remaining[symbol] / total
            if weight >= cap:
                capped[symbol] = cap
                budget -= cap
                del remaining[symbol]
                changed = True
        if not changed:
            for symbol, value in remaining.items():
                capped[symbol] = budget * value / total
            remaining.clear()
    total = sum(capped.values())
    return {symbol: weight / total for symbol, weight in capped.items()} if total > 0 else {}


def signature_informed_scores(
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    *,
    selection_pool_size: int,
    attention_gamma: float = 0.75,
    tail_penalty: float = 0.65,
    volatility_penalty: float = 0.10,
) -> dict[str, dict[str, Any]]:
    pool = _ranked_candidates(candidates, selection_pool_size)
    embeddings = {
        _symbol(row): _signature_embedding(return_history.get(_symbol(row), []))
        for row in pool
        if _symbol(row)
    }
    base_edges: dict[str, float] = {}
    for row in pool:
        symbol = _symbol(row)
        emb = embeddings.get(symbol) or {}
        base_edges[symbol] = (
            _expected_return(row)
            + 0.35 * float(emb.get("trend") or 0.0)
            + 0.20 * float(emb.get("recency") or 0.0)
            - tail_penalty * float(emb.get("cvar_loss") or 0.0)
            - volatility_penalty * float(emb.get("volatility") or 0.0)
        )

    out: dict[str, dict[str, Any]] = {}
    for row in pool:
        symbol = _symbol(row)
        emb = embeddings.get(symbol)
        if not emb:
            continue
        attention_logits: dict[str, float] = {}
        for peer in pool:
            peer_symbol = _symbol(peer)
            if not peer_symbol or peer_symbol == symbol:
                continue
            peer_emb = embeddings.get(peer_symbol)
            if not peer_emb:
                continue
            similarity = _dot(emb["vector"], peer_emb["vector"]) / math.sqrt(max(1, len(emb["vector"])))
            lead_lag_bias = _signed_area(
                return_history.get(peer_symbol, []),
                return_history.get(symbol, []),
            )
            attention_logits[peer_symbol] = similarity + attention_gamma * lead_lag_bias
        attention = _softmax(attention_logits)
        attention_support = sum(
            weight * max(0.0, base_edges.get(peer_symbol, 0.0))
            for peer_symbol, weight in attention.items()
        )
        direct_score = base_edges.get(symbol, 0.0) + 0.50 * attention_support
        out[symbol] = {
            "score": max(0.0, direct_score),
            "base_edge": base_edges.get(symbol, 0.0),
            "attention_support": attention_support,
            "top_attention": sorted(attention.items(), key=lambda item: item[1], reverse=True)[:3],
            "signature": {
                "trend": round(float(emb.get("trend") or 0.0), 8),
                "recency": round(float(emb.get("recency") or 0.0), 8),
                "volatility": round(float(emb.get("volatility") or 0.0), 8),
                "cvar_loss": round(float(emb.get("cvar_loss") or 0.0), 8),
                "max_drawdown": round(float(emb.get("max_drawdown") or 0.0), 8),
            },
        }
    return out


def allocate_signature_informed_transformer(
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    *,
    top_k: int,
    max_weight: float = 0.55,
    selection_pool_size: int | None = None,
    attention_gamma: float = 0.75,
    tail_penalty: float = 0.65,
    volatility_penalty: float = 0.10,
) -> dict[str, float]:
    top_k = max(1, int(top_k))
    pool_size = max(top_k, int(selection_pool_size or top_k * 4))
    scores = signature_informed_scores(
        candidates,
        return_history,
        selection_pool_size=pool_size,
        attention_gamma=attention_gamma,
        tail_penalty=tail_penalty,
        volatility_penalty=volatility_penalty,
    )
    ranked = sorted(scores, key=lambda symbol: float(scores[symbol].get("score") or 0.0), reverse=True)
    raw = {
        symbol: float(scores[symbol].get("score") or 0.0)
        for symbol in ranked[:top_k]
        if float(scores[symbol].get("score") or 0.0) > 0
    }
    if not raw:
        return allocate_rank_topk_equal_weight(candidates, top_k=top_k)
    return _cap_and_renormalize(raw, max_weight=max_weight)


def apply_signature_informed_production_allocation(
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

    weights = allocate_signature_informed_transformer(
        eligible_rows,
        return_history,
        top_k=top_k,
        max_weight=max_weight,
        selection_pool_size=selection_pool_size,
    )
    if not weights:
        return recommendations, {"status": "skipped", "reason": "empty_signature_weights"}
    diagnostics = signature_informed_scores(
        eligible_rows,
        return_history,
        selection_pool_size=selection_pool_size,
    )
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
        allocation.pop("selection_rank", None)
        allocation.pop("portfolio_selection_rank", None)
        allocation.pop("portfolio_selected", None)
        allocation.pop("equal_weight_baseline", None)
        allocation.pop("risk_pct_multiplier", None)
        allocation.pop("max_weight", None)
        if symbol in selected_symbols:
            rank = selected_order[symbol]
            weight = float(weights[symbol])
            row["allocation_replaced_signal"] = {
                "signal": row.get("signal"),
                "signal_source": row.get("signal_source"),
                "has_buy_signal": row.get("has_buy_signal"),
            }
            row["signal"] = "BUY"
            row["signal_source"] = SIT_METHOD
            row["has_buy_signal"] = 1
            row["confidence"] = max(_to_float(row.get("confidence")), float(confidence_floor))
            row["rank"] = rank
            row["alpha_allocation"] = {
                **allocation,
                "selected": True,
                "portfolio_selected": True,
                "selection_rank": rank,
                "portfolio_selection_rank": rank,
                "method": SIT_METHOD,
                "owner": "portfolio_allocation",
                "portfolio_weight": round(weight, 8),
                "equal_weight_baseline": round(equal_weight, 8),
                "risk_pct_multiplier": round(max(0.25, min(1.75, weight / equal_weight)), 8),
                "selection_pool_size": selection_pool_size,
                "max_weight": max_weight,
                "historical_return_days": usable_days,
                "signature_informed": diagnostics.get(symbol, {}),
            }
            selected.append(row)
        else:
            if enforce_buy_signal_owner:
                row["has_buy_signal"] = 0
            row["alpha_allocation"] = {
                **allocation,
                "selected": False,
                "portfolio_selected": False,
                "portfolio_selection_rank": None,
                "method": SIT_METHOD,
                "owner": "portfolio_allocation",
                "portfolio_weight": 0.0,
                "selection_pool_size": selection_pool_size,
                "historical_return_days": usable_days,
            }
            tail.append(row)

    tail = sorted(tail, key=_score, reverse=True)
    for idx, row in enumerate(tail, start=len(selected) + 1):
        row["rank"] = idx
    ordered = sorted(selected, key=lambda row: row["alpha_allocation"]["portfolio_selection_rank"]) + tail
    return ordered, {
        "status": "production_owner_applied",
        "method": SIT_METHOD,
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
        dt = str(row.get("date") or "").strip()[:10]
        close = _to_float(row.get("close"))
        if symbol and dt and close > 0:
            panel.setdefault(symbol, []).append((dt, close))
    return {symbol: sorted(rows, key=lambda item: item[0]) for symbol, rows in panel.items()}


def _history_for_symbol(panel: dict[str, list[tuple[str, float]]], symbol: str, as_of_date: str, lookback_days: int) -> list[float]:
    rows = [(dt, close) for dt, close in panel.get(symbol, []) if dt <= as_of_date]
    closes = [close for _, close in rows[-max(2, int(lookback_days) + 1):]]
    return _daily_returns_from_prices(closes)


def _next_return(panel: dict[str, list[tuple[str, float]]], symbol: str, as_of_date: str) -> float | None:
    rows = panel.get(symbol, [])
    current_idx = next((idx for idx, (dt, _) in enumerate(rows) if dt == as_of_date), None)
    if current_idx is None or current_idx + 1 >= len(rows):
        return None
    current = rows[current_idx][1]
    nxt = rows[current_idx + 1][1]
    return (nxt - current) / current if current > 0 and nxt > 0 else None


def _portfolio_returns_for_weights(weights: dict[str, float], realized: dict[str, float]) -> float:
    return sum(weight * float(realized[symbol]) for symbol, weight in weights.items())


def _average_turnover(weights_by_date: list[dict[str, float]]) -> float:
    turnovers: list[float] = []
    prev: dict[str, float] | None = None
    for current in weights_by_date:
        if prev is None:
            prev = current
            continue
        symbols = set(prev) | set(current)
        turnovers.append(0.5 * sum(abs(current.get(symbol, 0.0) - prev.get(symbol, 0.0)) for symbol in symbols))
        prev = current
    return round(sum(turnovers) / len(turnovers), 8) if turnovers else 0.0


def build_historical_sit_vs_sparse_report(
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
) -> dict[str, Any]:
    panel = _price_panel(price_rows)
    by_date: dict[str, list[dict[str, Any]]] = {}
    for row in recommendation_rows:
        dt = str(row.get("date") or "").strip()[:10]
        symbol = _symbol(row)
        if dt and symbol:
            by_date.setdefault(dt, []).append(_candidate(row))

    rank_returns: list[float] = []
    sparse_returns: list[float] = []
    sit_returns: list[float] = []
    sparse_weights_by_date: list[dict[str, float]] = []
    sit_weights_by_date: list[dict[str, float]] = []
    evaluated_dates: list[str] = []
    skipped_dates: list[dict[str, str]] = []

    top_k = max(1, int(top_k))
    selection_pool_size = max(top_k, int(selection_pool_size))
    for dt in sorted(day for day in by_date if start_date <= day <= end_date):
        candidates = sorted(by_date[dt], key=_score, reverse=True)
        if len(candidates) < top_k:
            skipped_dates.append({"date": dt, "reason": "insufficient_candidates"})
            continue
        return_history = {
            _symbol(row): _history_for_symbol(panel, _symbol(row), dt, lookback_days)
            for row in candidates
            if _symbol(row)
        }
        eligible = [
            row for row in candidates
            if len(return_history.get(_symbol(row), [])) >= min_history_days
        ]
        if len(eligible) < top_k:
            skipped_dates.append({"date": dt, "reason": "insufficient_return_history"})
            continue
        realized = {
            _symbol(row): _next_return(panel, _symbol(row), dt)
            for row in eligible
            if _symbol(row)
        }
        realized = {symbol: value for symbol, value in realized.items() if value is not None}
        rank_weights = allocate_rank_topk_equal_weight(eligible, top_k=top_k)
        sparse_weights = allocate_sparse_tangent(
            eligible,
            return_history,
            top_k=top_k,
            max_weight=max_weight,
            selection_pool_size=selection_pool_size,
        )
        sit_weights = allocate_signature_informed_transformer(
            eligible,
            return_history,
            top_k=top_k,
            max_weight=max_weight,
            selection_pool_size=selection_pool_size,
        )
        if not rank_weights or not sparse_weights or not sit_weights:
            skipped_dates.append({"date": dt, "reason": "empty_weights"})
            continue
        needed = set(rank_weights) | set(sparse_weights) | set(sit_weights)
        if not needed.issubset(realized):
            skipped_dates.append({"date": dt, "reason": "missing_next_return"})
            continue
        rank_returns.append(_portfolio_returns_for_weights(rank_weights, realized))
        sparse_returns.append(_portfolio_returns_for_weights(sparse_weights, realized))
        sit_returns.append(_portfolio_returns_for_weights(sit_weights, realized))
        sparse_weights_by_date.append(sparse_weights)
        sit_weights_by_date.append(sit_weights)
        evaluated_dates.append(dt)

    rank_metrics = portfolio_metrics(rank_returns)
    sparse_metrics = {
        **portfolio_metrics(sparse_returns),
        "average_turnover": _average_turnover(sparse_weights_by_date),
    }
    sit_metrics = {
        **portfolio_metrics(sit_returns),
        "average_turnover": _average_turnover(sit_weights_by_date),
    }
    sparse_sharpe = sparse_metrics.get("sharpe")
    sit_sharpe = sit_metrics.get("sharpe")
    sparse_mdd = sparse_metrics.get("max_drawdown")
    sit_mdd = sit_metrics.get("max_drawdown")
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": f"sit-vs-sparse:{start_date}:{end_date}",
        "date_range": {"start_date": start_date, "end_date": end_date},
        "baseline": {"owner": "rank_topk_equal_weight", "metrics": rank_metrics},
        "sparse_tangent": {"owner": "sparse_tangent_inverse_risk", "metrics": sparse_metrics},
        "signature_informed_transformer": {"owner": SIT_METHOD, "metrics": sit_metrics},
        "decision": {
            "sit_beats_sparse_on_sharpe": (
                sit_sharpe is not None and sparse_sharpe is not None and float(sit_sharpe) > float(sparse_sharpe)
            ),
            "sit_mdd_delta_vs_sparse": (
                round(float(sit_mdd) - float(sparse_mdd), 8)
                if sit_mdd is not None and sparse_mdd is not None else None
            ),
            "sit_sharpe_delta_vs_sparse": (
                round(float(sit_sharpe) - float(sparse_sharpe), 8)
                if sit_sharpe is not None and sparse_sharpe is not None else None
            ),
            "historical_replay_days": len(evaluated_dates),
            "production_mutation_allowed": False,
        },
        "evidence": {
            "evaluated_dates": evaluated_dates,
            "skipped_dates_sample": skipped_dates[:10],
            "recommendation_rows": len(recommendation_rows),
            "price_rows": len(price_rows),
            "top_k": top_k,
            "selection_pool_size": selection_pool_size,
            "lookback_days": lookback_days,
            "min_history_days": min_history_days,
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


def load_historical_sit_inputs(
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
               dr.alpha_allocation, p.forecast_data
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


def run_historical_sit_vs_sparse_report(
    *,
    start_date: str,
    end_date: str,
    top_k: int = 3,
    selection_pool_size: int = 30,
    lookback_days: int = 60,
    max_weight: float = 0.55,
    min_history_days: int = 20,
) -> dict[str, Any]:
    recommendation_rows, price_rows = load_historical_sit_inputs(
        start_date=start_date,
        end_date=end_date,
        lookback_days=lookback_days,
    )
    return build_historical_sit_vs_sparse_report(
        recommendation_rows=recommendation_rows,
        price_rows=price_rows,
        start_date=start_date,
        end_date=end_date,
        top_k=top_k,
        selection_pool_size=selection_pool_size,
        lookback_days=lookback_days,
        max_weight=max_weight,
        min_history_days=min_history_days,
    )
