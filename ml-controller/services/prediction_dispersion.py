from __future__ import annotations

import math
from collections import defaultdict
from statistics import mean, pstdev
from typing import Any


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _rank_scores(pred: dict[str, Any]) -> dict[str, float]:
    scores: dict[str, float] = {}
    raw = pred.get("rank_scores") or {}
    if isinstance(raw, dict):
        for name, value in raw.items():
            number = _finite_float(value)
            if number is not None:
                scores[str(name)] = max(0.0, min(1.0, number))
    for src_key, model_name in (("chronos", "Chronos"), ("dlinear", "DLinear"), ("patchtst", "PatchTST")):
        signal = pred.get(src_key) or {}
        if not isinstance(signal, dict):
            continue
        forecast = _finite_float(signal.get("forecast_pct"))
        if forecast is None:
            continue
        x = max(-50.0, min(50.0, forecast * 12.0))
        scores[model_name] = 1.0 / (1.0 + math.exp(-x))
    return scores


def _positive_weights(pred: dict[str, Any]) -> dict[str, float]:
    ev2 = pred.get("ensemble_v2") or {}
    raw = ev2.get("weights") if isinstance(ev2, dict) else {}
    weights: dict[str, float] = {}
    if isinstance(raw, dict):
        for name, value in raw.items():
            number = _finite_float(value)
            if number is not None and number > 0:
                weights[str(name)] = number
    return weights


def _hhi(weights: dict[str, float]) -> float:
    total = sum(max(0.0, w) for w in weights.values())
    if total <= 0:
        return 0.0
    return sum((max(0.0, w) / total) ** 2 for w in weights.values())


def _pairwise_corr(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or len(xs) != len(ys):
        return None
    mx = mean(xs)
    my = mean(ys)
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 1e-12 or vy <= 1e-12:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    corr = cov / math.sqrt(vx * vy)
    return max(-1.0, min(1.0, corr))


def build_prediction_dispersion_report(predictions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Measure whether raw model outputs are diverse or merge logic compresses them.

    The report is intentionally model-agnostic and cheap enough to run during the
    daily pipeline. It answers the operational question: "Are models truly
    agreeing, or did lifecycle weighting/calibration flatten the signal?"
    """
    by_model: dict[str, dict[str, float]] = defaultdict(dict)
    symbol_reports: dict[str, dict[str, Any]] = {}
    raw_stds: list[float] = []
    merge_compressions: list[float] = []
    active_weight_counts: list[int] = []
    weight_hhis: list[float] = []

    for symbol, pred in (predictions or {}).items():
        if not isinstance(pred, dict) or pred.get("error"):
            continue
        scores = _rank_scores(pred)
        if not scores:
            continue
        values = list(scores.values())
        raw_mean = mean(values)
        raw_std = pstdev(values) if len(values) > 1 else 0.0
        weights = _positive_weights(pred)
        ev2 = pred.get("ensemble_v2") or {}
        avg_rank = _finite_float(ev2.get("avg_rank") if isinstance(ev2, dict) else None)
        compression = abs((avg_rank if avg_rank is not None else raw_mean) - raw_mean)
        hhi = _hhi(weights)

        raw_stds.append(raw_std)
        merge_compressions.append(compression)
        active_weight_counts.append(len(weights))
        weight_hhis.append(hhi)

        for model_name, score in scores.items():
            by_model[model_name][str(symbol)] = score

        symbol_reports[str(symbol)] = {
            "raw_model_count": len(scores),
            "raw_rank_mean": round(raw_mean, 6),
            "raw_rank_std": round(raw_std, 6),
            "ensemble_avg_rank": round(avg_rank, 6) if avg_rank is not None else None,
            "merge_compression": round(compression, 6),
            "active_weight_count": len(weights),
            "weight_hhi": round(hhi, 6),
            "zero_weight_models": sorted(set(scores) - set(weights)),
        }
        pred["dispersion_diagnostics"] = symbol_reports[str(symbol)]

    correlations: list[float] = []
    model_names = sorted(by_model)
    for idx, left in enumerate(model_names):
        for right in model_names[idx + 1:]:
            shared = sorted(set(by_model[left]) & set(by_model[right]))
            corr = _pairwise_corr(
                [by_model[left][sym] for sym in shared],
                [by_model[right][sym] for sym in shared],
            )
            if corr is not None:
                correlations.append(corr)

    avg_raw_std = mean(raw_stds) if raw_stds else 0.0
    avg_compression = mean(merge_compressions) if merge_compressions else 0.0
    avg_active = mean(active_weight_counts) if active_weight_counts else 0.0
    avg_hhi = mean(weight_hhis) if weight_hhis else 0.0
    avg_corr = mean(correlations) if correlations else None

    flags: list[str] = []
    if raw_stds and avg_raw_std < 0.04:
        flags.append("low_raw_model_dispersion")
    if active_weight_counts and avg_active < 4:
        flags.append("low_active_weight_count")
    if weight_hhis and avg_hhi > 0.45:
        flags.append("high_weight_concentration")
    if avg_corr is not None and avg_corr > 0.85:
        flags.append("high_pairwise_model_correlation")
    if merge_compressions and avg_compression > 0.08:
        flags.append("high_merge_compression")

    return {
        "n_symbols": len(symbol_reports),
        "n_models_seen": len(model_names),
        "avg_raw_rank_std": round(avg_raw_std, 6),
        "avg_merge_compression": round(avg_compression, 6),
        "avg_active_weight_count": round(avg_active, 3),
        "avg_weight_hhi": round(avg_hhi, 6),
        "avg_pairwise_model_corr": round(avg_corr, 6) if avg_corr is not None else None,
        "model_coverage": {name: len(rows) for name, rows in sorted(by_model.items())},
        "flags": flags,
        "symbol_count_low_dispersion": sum(1 for row in symbol_reports.values() if row["raw_rank_std"] < 0.04),
        "symbol_count_low_active_weights": sum(1 for row in symbol_reports.values() if row["active_weight_count"] < 4),
        "symbols": symbol_reports,
    }
