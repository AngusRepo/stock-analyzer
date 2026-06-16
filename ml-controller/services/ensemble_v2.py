from __future__ import annotations

import math


_SRC_KEY_MODEL = (
    ("dlinear", "DLinear"),
    ("patchtst", "PatchTST"),
    ("itransformer", "iTransformer"),
    ("timesfm", "TimesFM"),
)
_MODEL_STATUS_ALLOWED = {"active", "degraded", "challenger", "retired"}


def _ts_to_rank(forecast_pct: float, scale: float = 12.0) -> float:
    x = max(-50.0, min(50.0, forecast_pct * scale))
    return 1.0 / (1.0 + math.exp(-x))


def _rank_confidence(avg_rank: float) -> float:
    return round(0.5 + abs(avg_rank - 0.5), 4)


def _calibrated_forecast_pct(avg_rank: float, ev2_cfg: dict | None = None) -> tuple[float | None, str, dict]:
    """Map ensemble rank to expected return only when verified calibration exists."""
    calibration = (ev2_cfg or {}).get("expectedReturnCalibration") or {}
    bins = calibration.get("bins") if isinstance(calibration, dict) else None
    min_samples = int(calibration.get("minSamples", 1) or 1) if isinstance(calibration, dict) else 1
    if isinstance(bins, list):
        for idx, row in enumerate(bins):
            if not isinstance(row, dict):
                continue
            try:
                low = float(row.get("rankLow", row.get("rank_low")))
                high = float(row.get("rankHigh", row.get("rank_high")))
                samples = int(row.get("samples") or 0)
                mean_return = float(
                    row.get("meanReturn", row.get("mean_return", row.get("medianReturn", row.get("median_return"))))
                )
            except (TypeError, ValueError):
                continue
            upper_ok = avg_rank <= high if idx == len(bins) - 1 or high >= 1.0 else avg_rank < high
            if samples >= min_samples and avg_rank >= low and upper_ok:
                return round(mean_return, 6), "calibrated_rank_bin", {
                    "forecast_calibration_method": calibration.get("method") or "empirical_rank_bins",
                    "forecast_calibration_status": calibration.get("status") or "configured",
                    "forecast_calibration_source": calibration.get("source"),
                    "forecast_calibration_sample_count": calibration.get("sampleCount"),
                    "forecast_calibration_bin_samples": samples,
                    "forecast_calibration_bin": {"rankLow": low, "rankHigh": high},
                }
    return None, "uncalibrated_rank_score", {
        "forecast_calibration_method": calibration.get("method") if isinstance(calibration, dict) else None,
        "forecast_calibration_status": (
            calibration.get("status") if isinstance(calibration, dict) and calibration
            else (ev2_cfg or {}).get("expectedReturnCalibrationRuntime", {}).get("status")
            if isinstance((ev2_cfg or {}).get("expectedReturnCalibrationRuntime"), dict)
            else "missing"
        ),
        "forecast_calibration_source": calibration.get("source") if isinstance(calibration, dict) else None,
        "forecast_calibration_sample_count": calibration.get("sampleCount") if isinstance(calibration, dict) else None,
    }


def _forecast_fields(avg_rank: float, ev2_cfg: dict | None = None) -> dict:
    forecast, source, meta = _calibrated_forecast_pct(avg_rank, ev2_cfg)
    return {
        "forecast_pct": forecast,
        "forecast_pct_source": source,
        **meta,
    }


def _compute_lifecycle_weight(status: str, ic_value: float, degraded_dampening: float) -> float:
    base = max(0.0, float(ic_value or 0.0))
    if status in ("retired", "challenger"):
        return 0.0
    if status == "degraded":
        return base * max(0.0, degraded_dampening)
    return base


def _weight_status(model_status: dict, model_name: str) -> str:
    status = str((model_status or {}).get(model_name) or "retired").strip()
    return status if status in _MODEL_STATUS_ALLOWED else "retired"


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

    observed_ic_models = set((ev2_cfg or {}).get("observedIcModels") or [])
    weights = {
        name: _compute_lifecycle_weight(
            _weight_status(model_status, name),
            ic_weights.get(name, 0.0),
            degraded_dampening,
        )
        for name in merged
    }
    weight_total = sum(weights.values())

    if weight_total <= 0:
        allow_cold_start = bool((ev2_cfg or {}).get("allowColdStartEqualWeight", False))
        if allow_cold_start and not (_has_observed_ic(merged, ic_weights) or (set(merged) & observed_ic_models)):
            weights = {
                name: _cold_start_weight(_weight_status(model_status, name), degraded_dampening)
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
                "signal_source": "ensemble_v2",
                "contributing_models": sorted([name for name, weight in weights.items() if weight > 0]),
                "weights": {k: round(v, 6) for k, v in weights.items()},
                "weight_total": round(weight_total, 6),
                "reason": "cold_start_equal_weight",
                "weight_formula": "cold_start_equal_weight_until_ic_available",
                **_forecast_fields(avg, ev2_cfg),
            }
            return
        pred["ensemble_v2"] = {
            "avg_rank": 0.5,
            "signal": "HOLD",
            "confidence": 0.5,
            "forecast_pct": None,
            "forecast_pct_source": "no_positive_lifecycle_weight",
            "signal_source": "ensemble_v2",
            "contributing_models": [],
            "weights": {k: round(v, 6) for k, v in weights.items()},
            "weight_total": 0.0,
            "reason": "no_positive_lifecycle_weight",
            "weight_formula": "max(0,shrunk_ic) * status_filter * dampening_if_degraded",
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
        "signal_source": "ensemble_v2",
        "contributing_models": sorted([name for name, weight in weights.items() if weight > 0]),
        "weights": {k: round(v, 6) for k, v in weights.items()},
        "weight_total": round(weight_total, 6),
        "weight_formula": "max(0,shrunk_ic) * status_filter * dampening_if_degraded",
        **_forecast_fields(avg, ev2_cfg),
    }
