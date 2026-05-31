from __future__ import annotations

import math
from typing import Any

import numpy as np


def _price_array(row: dict[str, Any]) -> np.ndarray:
    values = []
    for value in row.get("prices") or []:
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(numeric) and numeric > 0:
            values.append(numeric)
    return np.asarray(values, dtype=np.float32)


def _rank_score(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.5
    if not math.isfinite(numeric):
        return 0.5
    return max(0.0, min(1.0, numeric))


def _forecast_signal(forecast_pct: float) -> str:
    if forecast_pct >= 0.03:
        return "STRONG_BUY"
    if forecast_pct >= 0.01:
        return "BUY"
    if forecast_pct <= -0.03:
        return "STRONG_SELL"
    if forecast_pct <= -0.01:
        return "SELL"
    return "HOLD"


def gnn_graph_batch_predict(series_list: list[dict[str, Any]], *, corr_threshold: float = 0.45) -> list[dict[str, Any]]:
    """Production graph branch: correlation graph propagation over L2 core candidates.

    This is inference-only and does not create or mutate artifacts. It turns the
    current core universe into a relation graph, then propagates existing
    production feature ranks through same-day cross-stock neighborhoods.
    """
    symbols: list[str] = []
    returns: list[np.ndarray] = []
    base_scores: list[float] = []
    for row in series_list:
        prices = _price_array(row)
        if prices.size < 8:
            continue
        ret = np.diff(np.log(prices))
        if ret.size < 5:
            continue
        symbols.append(str(row.get("symbol") or ""))
        returns.append(ret[-60:])
        base_scores.append(_rank_score(row.get("feature_score")))

    if not symbols:
        return [
            {"symbol": str(row.get("symbol") or ""), "error": "insufficient_series_for_gnn"}
            for row in series_list
        ]

    min_len = min(len(row) for row in returns)
    matrix = np.vstack([row[-min_len:] for row in returns])
    corr = np.nan_to_num(np.corrcoef(matrix), nan=0.0, posinf=0.0, neginf=0.0)
    base = np.asarray(base_scores, dtype=np.float32)
    propagated: list[dict[str, Any]] = []
    for i, symbol in enumerate(symbols):
        weights = np.abs(corr[i])
        weights[i] = 0.0
        mask = weights >= corr_threshold
        if mask.any():
            neighbor_score = float(np.average(base[mask], weights=weights[mask]))
            edge_count = int(mask.sum())
        else:
            neighbor_score = float(base[i])
            edge_count = 0
        score = 0.65 * float(base[i]) + 0.35 * neighbor_score
        forecast_pct = (score - 0.5) * 0.08
        propagated.append({
            "symbol": symbol,
            "model_name": "GNN",
            "rank_score": round(max(0.0, min(1.0, score)), 6),
            "forecast_pct": round(forecast_pct, 6),
            "signal": _forecast_signal(forecast_pct),
            "confidence": round(0.5 + min(0.35, abs(score - 0.5)), 4),
            "edge_count": edge_count,
            "corr_threshold": corr_threshold,
            "serving_mode": "production_graph_propagation",
        })

    seen = {row["symbol"] for row in propagated}
    for row in series_list:
        symbol = str(row.get("symbol") or "")
        if symbol and symbol not in seen:
            propagated.append({"symbol": symbol, "error": "insufficient_series_for_gnn"})
    return propagated


def timesfm_batch_predict(series_list: list[dict[str, Any]], *, horizon: int = 5) -> list[dict[str, Any]]:
    """Production foundation sequence branch via TimesFM zero-shot inference."""
    from app.research_benchmarks.timesfm_adapter import _forecast_timesfm, _load_timesfm_model

    usable: list[tuple[str, np.ndarray]] = []
    for row in series_list:
        prices = _price_array(row)
        symbol = str(row.get("symbol") or "")
        if symbol and prices.size >= 16:
            usable.append((symbol, prices[-1024:]))
    if not usable:
        return [
            {"symbol": str(row.get("symbol") or ""), "error": "insufficient_series_for_timesfm"}
            for row in series_list
        ]

    model = _load_timesfm_model({"max_horizon": max(1, int(horizon)), "max_context": 1024})
    point_forecast, _quantiles = _forecast_timesfm(
        model,
        horizon=max(1, int(horizon)),
        inputs=[prices.astype(np.float32) for _, prices in usable],
    )
    forecast_array = np.asarray(point_forecast, dtype=float)
    results: list[dict[str, Any]] = []
    for idx, (symbol, prices) in enumerate(usable):
        last_close = float(prices[-1])
        forecast_close = float(forecast_array[idx, -1])
        forecast_pct = (forecast_close - last_close) / max(last_close, 1e-9)
        score = 1.0 / (1.0 + math.exp(-forecast_pct * 12.0))
        results.append({
            "symbol": symbol,
            "model_name": "TimesFM",
            "forecast_pct": round(forecast_pct, 6),
            "rank_score": round(max(0.0, min(1.0, score)), 6),
            "signal": _forecast_signal(forecast_pct),
            "confidence": round(0.5 + min(0.35, abs(score - 0.5)), 4),
            "horizon": int(horizon),
            "serving_mode": "production_zero_shot_foundation_sequence",
        })

    seen = {row["symbol"] for row in results}
    for row in series_list:
        symbol = str(row.get("symbol") or "")
        if symbol and symbol not in seen:
            results.append({"symbol": symbol, "error": "insufficient_series_for_timesfm"})
    return results


def layer3_formal_batch_predict(payload: dict[str, Any]) -> dict[str, Any]:
    series_list = payload.get("series_list") or []
    requested = {str(name) for name in (payload.get("models") or ["GNN", "TimesFM"])}
    overlays: dict[str, list[dict[str, Any]]] = {}
    blockers: dict[str, str] = {}

    if "GNN" in requested:
        overlays["GNN"] = gnn_graph_batch_predict(series_list, corr_threshold=float(payload.get("gnn_corr_threshold") or 0.45))
    if "TimesFM" in requested:
        try:
            overlays["TimesFM"] = timesfm_batch_predict(series_list, horizon=int(payload.get("horizon") or 5))
        except Exception as exc:  # noqa: BLE001 - TimesFM must fail closed independently.
            overlays["TimesFM"] = [
                {"symbol": str(row.get("symbol") or ""), "error": f"timesfm_unavailable:{type(exc).__name__}:{exc}"}
                for row in series_list
            ]
            blockers["TimesFM"] = str(exc)

    for model_name in ("TabM", "iTransformer"):
        if model_name in requested:
            blockers[model_name] = "artifact_missing: GCS universal artifact required before production serving"

    return {
        "schema_version": "layer3-formal-universal-v1",
        "overlays": overlays,
        "blockers": blockers,
        "n_input": len(series_list),
        "active_models": [name for name, rows in overlays.items() if any(not row.get("error") for row in rows)],
    }
