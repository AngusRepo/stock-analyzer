from __future__ import annotations

import math


_SRC_KEY_MODEL = (
    ("chronos", "Chronos"),
    ("dlinear", "DLinear"),
    ("patchtst", "PatchTST"),
    ("kalman_filter", "KalmanFilter"),
    ("markov_switching", "MarkovSwitching"),
)


def _ts_to_rank(forecast_pct: float, scale: float = 12.0) -> float:
    x = max(-50.0, min(50.0, forecast_pct * scale))
    return 1.0 / (1.0 + math.exp(-x))


def _rank_confidence(avg_rank: float) -> float:
    return round(0.5 + abs(avg_rank - 0.5), 4)


def _rank_forecast_pct(avg_rank: float) -> float:
    return round(max(-0.05, min(0.05, (avg_rank - 0.5) * 0.10)), 4)


def _compute_lifecycle_weight(status: str, ic_value: float, degraded_dampening: float) -> float:
    base = max(0.0, float(ic_value or 0.0))
    if status in ("retired", "challenger"):
        return 0.0
    if status == "degraded":
        return base * max(0.0, degraded_dampening)
    return base


def _has_observed_ic(merged: dict[str, float], ic_weights: dict) -> bool:
    for name in merged:
        try:
            if abs(float(ic_weights.get(name, 0.0) or 0.0)) > 1e-12:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _cold_start_weight(status: str, degraded_dampening: float) -> float:
    if status in ("retired", "challenger"):
        return 0.0
    if status == "degraded":
        return max(0.0, float(degraded_dampening))
    return 1.0


def attach_ensemble_v2(
    pred: dict,
    model_status: dict,
    ic_weights: dict,
    degraded_dampening: float,
    ev2_cfg: dict | None = None,
) -> None:
    feat_ranks = pred.get("rank_scores") or {}
    merged: dict[str, float] = dict(feat_ranks)
    for src_key, model_name in _SRC_KEY_MODEL:
        sig = pred.get(src_key) or {}
        if sig.get("forecast_pct") is None:
            continue
        merged[model_name] = _ts_to_rank(float(sig["forecast_pct"]))
    if not merged:
        return

    weights = {
        name: _compute_lifecycle_weight(
            model_status.get(name, "active"),
            ic_weights.get(name, 0.0),
            degraded_dampening,
        )
        for name in merged
    }
    weight_total = sum(weights.values())

    if weight_total <= 0:
        if not _has_observed_ic(merged, ic_weights):
            weights = {
                name: _cold_start_weight(model_status.get(name, "active"), degraded_dampening)
                for name in merged
            }
            weight_total = sum(weights.values())
        if weight_total > 0:
            avg = sum(merged[name] * weights[name] for name in merged) / weight_total
            cfg = ev2_cfg or {}
            sb_th = float(cfg.get("strongBuyThreshold", 0.85))
            b_th = float(cfg.get("buyThreshold", 0.70))
            ss_th = float(cfg.get("strongSellThreshold", 0.15))
            s_th = float(cfg.get("sellThreshold", 0.30))

            if avg >= sb_th:
                label = "STRONG_BUY"
            elif avg >= b_th:
                label = "BUY"
            elif avg <= ss_th:
                label = "STRONG_SELL"
            elif avg <= s_th:
                label = "SELL"
            else:
                label = "HOLD"

            pred["ensemble_v2"] = {
                "avg_rank": round(avg, 4),
                "signal": label,
                "confidence": _rank_confidence(avg),
                "forecast_pct": _rank_forecast_pct(avg),
                "signal_source": "ensemble_v2",
                "contributing_models": sorted([name for name, weight in weights.items() if weight > 0]),
                "weights": {k: round(v, 6) for k, v in weights.items()},
                "weight_total": round(weight_total, 6),
                "reason": "cold_start_equal_weight",
                "weight_formula": "cold_start_equal_weight_until_ic_available",
            }
            return
        pred["ensemble_v2"] = {
            "avg_rank": 0.5,
            "signal": "HOLD",
            "confidence": 0.5,
            "forecast_pct": 0.0,
            "signal_source": "ensemble_v2",
            "contributing_models": [],
            "weights": {k: round(v, 6) for k, v in weights.items()},
            "weight_total": 0.0,
            "reason": "no_positive_lifecycle_weight",
            "weight_formula": "max(0,ic) * status_filter * dampening_if_degraded",
        }
        return

    avg = sum(merged[name] * weights[name] for name in merged) / weight_total
    cfg = ev2_cfg or {}
    sb_th = float(cfg.get("strongBuyThreshold", 0.85))
    b_th = float(cfg.get("buyThreshold", 0.70))
    ss_th = float(cfg.get("strongSellThreshold", 0.15))
    s_th = float(cfg.get("sellThreshold", 0.30))

    if avg >= sb_th:
        label = "STRONG_BUY"
    elif avg >= b_th:
        label = "BUY"
    elif avg <= ss_th:
        label = "STRONG_SELL"
    elif avg <= s_th:
        label = "SELL"
    else:
        label = "HOLD"

    pred["ensemble_v2"] = {
        "avg_rank": round(avg, 4),
        "signal": label,
        "confidence": _rank_confidence(avg),
        "forecast_pct": _rank_forecast_pct(avg),
        "signal_source": "ensemble_v2",
        "contributing_models": sorted([name for name, weight in weights.items() if weight > 0]),
        "weights": {k: round(v, 6) for k, v in weights.items()},
        "weight_total": round(weight_total, 6),
        "weight_formula": "max(0,ic) * status_filter * dampening_if_degraded",
    }
