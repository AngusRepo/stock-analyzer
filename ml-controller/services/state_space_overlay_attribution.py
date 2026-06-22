from __future__ import annotations

import json
import math
from statistics import mean
from typing import Any


def _loads_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        data = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _to_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _chosen_outcome(row: dict[str, Any]) -> tuple[float | None, str | None]:
    for key in ("trade_pnl_pct", "actual_return_pct", "trade_pnl_r"):
        value = _to_float(row.get(key))
        if value is not None:
            return value, key
    return None, None


def _state_space_overlays(forecast: dict[str, Any]) -> dict[str, Any]:
    overlays = forecast.get("state_space_overlays")
    if isinstance(overlays, dict):
        return overlays
    legacy = {}
    if isinstance(forecast.get("kalman_filter"), dict):
        legacy["kalman_filter"] = forecast["kalman_filter"]
    if isinstance(forecast.get("markov_switching"), dict):
        legacy["markov_switching"] = forecast["markov_switching"]
    return legacy


def _markov_overlay(row: dict[str, Any]) -> dict[str, Any]:
    forecast = _loads_json(row.get("forecast_data"))
    overlay = _state_space_overlays(forecast).get("markov_switching")
    return overlay if isinstance(overlay, dict) else {}


def _signal(row: dict[str, Any]) -> str:
    forecast = _loads_json(row.get("forecast_data"))
    return str(
        row.get("trade_signal")
        or row.get("signal_raw")
        or forecast.get("signal")
        or ""
    ).upper()


def _is_buy(row: dict[str, Any]) -> bool:
    signal = _signal(row)
    return signal == "BUY" or signal == "STRONG_BUY" or signal == "BUY_SIGNAL" or "BUY" in signal


def _markov_bucket(
    overlay: dict[str, Any],
    *,
    min_confidence: float,
    min_abs_forecast_pct: float,
) -> str:
    confidence = _to_float(overlay.get("confidence"))
    if confidence is not None and confidence < min_confidence:
        return "low_confidence"

    direction = str(overlay.get("direction") or overlay.get("signal") or "").lower()
    forecast_pct = _to_float(overlay.get("forecast_pct"))
    up_prob = _to_float(overlay.get("up_prob"))

    if any(token in direction for token in ("down", "sell", "bear")):
        return "bearish"
    if any(token in direction for token in ("up", "buy", "bull")):
        return "bullish"
    if forecast_pct is not None:
        if forecast_pct <= -abs(min_abs_forecast_pct):
            return "bearish"
        if forecast_pct >= abs(min_abs_forecast_pct):
            return "bullish"
    if up_prob is not None:
        if up_prob < 0.5:
            return "bearish"
        if up_prob > 0.5:
            return "bullish"
    return "neutral"


def _stat(samples: list[dict[str, Any]]) -> dict[str, Any]:
    outcomes = [sample["outcome"] for sample in samples if sample.get("outcome") is not None]
    trade_pnls = [sample["trade_pnl_pct"] for sample in samples if sample.get("trade_pnl_pct") is not None]
    actual_returns = [sample["actual_return_pct"] for sample in samples if sample.get("actual_return_pct") is not None]
    wins = sum(1 for value in outcomes if value > 0)
    return {
        "count": len(samples),
        "avg_outcome": round(mean(outcomes), 6) if outcomes else None,
        "hit_rate": round(wins / len(outcomes), 4) if outcomes else None,
        "avg_trade_pnl_pct": round(mean(trade_pnls), 6) if trade_pnls else None,
        "avg_actual_return_pct": round(mean(actual_returns), 6) if actual_returns else None,
    }


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    pairs = [(x, y) for x, y in zip(xs, ys) if math.isfinite(x) and math.isfinite(y)]
    if len(pairs) < 3:
        return None
    x_vals = [x for x, _ in pairs]
    y_vals = [y for _, y in pairs]
    x_mean = mean(x_vals)
    y_mean = mean(y_vals)
    x_var = sum((x - x_mean) ** 2 for x in x_vals)
    y_var = sum((y - y_mean) ** 2 for y in y_vals)
    if x_var <= 0 or y_var <= 0:
        return None
    cov = sum((x - x_mean) * (y - y_mean) for x, y in pairs)
    return round(cov / math.sqrt(x_var * y_var), 6)


def _samples(
    rows: list[dict[str, Any]],
    *,
    min_confidence: float,
    min_abs_forecast_pct: float,
) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for row in rows:
        overlay = _markov_overlay(row)
        if not overlay or overlay.get("error"):
            continue
        outcome, outcome_source = _chosen_outcome(row)
        if outcome is None:
            continue
        forecast_pct = _to_float(overlay.get("forecast_pct"))
        up_prob = _to_float(overlay.get("up_prob"))
        samples.append({
            "symbol": row.get("symbol"),
            "prediction_date": row.get("prediction_date"),
            "bucket": _markov_bucket(
                overlay,
                min_confidence=min_confidence,
                min_abs_forecast_pct=min_abs_forecast_pct,
            ),
            "is_buy": _is_buy(row),
            "outcome": outcome,
            "outcome_source": outcome_source,
            "trade_pnl_pct": _to_float(row.get("trade_pnl_pct")),
            "actual_return_pct": _to_float(row.get("actual_return_pct")),
            "forecast_pct": forecast_pct,
            "up_prob": up_prob,
            "confidence": _to_float(overlay.get("confidence")),
            "degraded": bool(overlay.get("degraded")),
            "fallback_reason": overlay.get("fallback_reason"),
        })
    return samples


def evaluate_markov_switching_overlay(
    rows: list[dict[str, Any]],
    *,
    min_samples: int = 30,
    min_gate_samples: int = 5,
    min_confidence: float = 0.0,
    min_abs_forecast_pct: float = 0.0,
    min_avg_delta: float = 0.0,
) -> dict[str, Any]:
    """Evaluate MarkovSwitching as a shadow risk/context gate.

    This report does not promote Markov into alpha voting. It asks whether a
    simple bearish-Markov skip gate would have improved verified BUY outcomes.
    """
    samples = _samples(
        rows,
        min_confidence=min_confidence,
        min_abs_forecast_pct=min_abs_forecast_pct,
    )
    if len(samples) < min_samples:
        return {
            "status": "skipped",
            "reason": "insufficient_markov_overlay_samples",
            "sample_count": len(samples),
            "required_samples": min_samples,
        }

    by_bucket: dict[str, list[dict[str, Any]]] = {}
    for sample in samples:
        by_bucket.setdefault(sample["bucket"], []).append(sample)

    buy_samples = [sample for sample in samples if sample["is_buy"]]
    bearish_buy = [sample for sample in buy_samples if sample["bucket"] == "bearish"]
    non_bearish_buy = [sample for sample in buy_samples if sample["bucket"] != "bearish"]
    baseline_stat = _stat(buy_samples)
    after_skip_stat = _stat(non_bearish_buy)
    delta = None
    if baseline_stat["avg_outcome"] is not None and after_skip_stat["avg_outcome"] is not None:
        delta = round(after_skip_stat["avg_outcome"] - baseline_stat["avg_outcome"], 6)

    forecast_pairs = [
        (sample["forecast_pct"], sample["outcome"])
        for sample in samples
        if sample.get("forecast_pct") is not None and sample.get("outcome") is not None
    ]
    up_prob_pairs = [
        (sample["up_prob"], sample["outcome"])
        for sample in samples
        if sample.get("up_prob") is not None and sample.get("outcome") is not None
    ]

    gate_decision = "insufficient_gate_samples"
    if len(bearish_buy) >= min_gate_samples and delta is not None:
        gate_decision = "candidate_positive" if delta > min_avg_delta else "no_uplift"

    return {
        "status": "completed",
        "schema_version": "markov-switching-overlay-attribution-v1",
        "sample_count": len(samples),
        "fallback_count": sum(1 for sample in samples if sample["degraded"] or sample.get("fallback_reason")),
        "fallback_reasons": {
            str(reason): sum(1 for sample in samples if sample.get("fallback_reason") == reason)
            for reason in sorted({sample.get("fallback_reason") for sample in samples if sample.get("fallback_reason")})
        },
        "by_markov_bucket": {
            bucket: _stat(values)
            for bucket, values in sorted(by_bucket.items())
        },
        "correlation": {
            "forecast_pct_to_outcome": _pearson(
                [float(x) for x, _ in forecast_pairs],
                [float(y) for _, y in forecast_pairs],
            ),
            "up_prob_to_outcome": _pearson(
                [float(x) for x, _ in up_prob_pairs],
                [float(y) for _, y in up_prob_pairs],
            ),
        },
        "bearish_buy_skip_simulation": {
            "decision": gate_decision,
            "buy_count": len(buy_samples),
            "bearish_buy_count": len(bearish_buy),
            "non_bearish_buy_count": len(non_bearish_buy),
            "baseline_buy": baseline_stat,
            "after_skipping_bearish_markov_buy": after_skip_stat,
            "avg_outcome_delta": delta,
            "avoided_negative_outcome_sum": round(
                -sum(min(0.0, float(sample["outcome"])) for sample in bearish_buy),
                6,
            ),
        },
        "params": {
            "min_samples": min_samples,
            "min_gate_samples": min_gate_samples,
            "min_confidence": min_confidence,
            "min_abs_forecast_pct": min_abs_forecast_pct,
            "min_avg_delta": min_avg_delta,
        },
    }


def load_markov_switching_overlay_rows(limit: int = 1000) -> list[dict[str, Any]]:
    """Load verified ensemble rows with persisted MarkovSwitching overlay data."""
    from services.d1_client import query as d1_query

    safe_limit = max(1, min(int(limit or 1000), 5000))
    return d1_query(
        """SELECT p.generated_at,
                  p.prediction_date,
                  s.symbol,
                  p.trade_signal,
                  p.signal_raw,
                  p.forecast_data,
                  p.actual_return_pct,
                  p.trade_pnl_pct,
                  p.trade_pnl_r,
                  p.direction_correct
           FROM predictions p
           LEFT JOIN stocks s ON s.id = p.stock_id
           WHERE p.model_name='ensemble'
             AND p.forecast_data IS NOT NULL
             AND p.forecast_data LIKE '%markov_switching%'
             AND (
               p.trade_pnl_r IS NOT NULL OR p.trade_pnl_pct IS NOT NULL
               OR p.actual_return_pct IS NOT NULL OR p.direction_correct IN (0, 1)
             )
           ORDER BY p.generated_at DESC
           LIMIT ?""",
        [safe_limit],
    )
