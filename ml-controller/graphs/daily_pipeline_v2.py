"""
daily_pipeline_v2.py — Real LangGraph StateGraph for daily prediction pipeline
2026-04-07 LangGraph A+B refactor

Replaces graphs/daily_pipeline.py which was a "fake LangGraph" — fire-and-forget
HTTP shell where state held only step_status, not domain data.

Real LangGraph this time:
  - State is typed schema with full domain data (active_stocks, payloads, predictions, etc.)
  - Nodes are pure functions reading & writing state
  - All D1/ML calls done by ml-controller directly (no fire-and-forget to worker)
  - Checkpointer disabled until a durable async backend is selected
  - Linear edges screener_load → market_env → payloads → ml_predict → recommend → llm_reasons → write_d1
"""
from __future__ import annotations
import asyncio
import logging
import operator
from datetime import datetime, timezone
from typing import Annotated, Any, TypedDict

from langgraph.graph import StateGraph, END
from langgraph.types import RetryPolicy

from services import d1_client, kv_client
from services.ensemble_v2 import attach_ensemble_v2
from services.payload_builder import (
    PredictPayload,
    load_active_stocks,
    load_market_env,
    build_payloads,
    build_ml_universe,
)
from services.modal_client import batch_predict
from services.model_score_quality import drop_degenerate_rank_scores
from services.recommendation_service import (
    build_screener_seed_recommendations,
    filter_and_score_recommendations,
    hybrid_ranking_promotion,
    write_predictions_to_d1,
    update_recommendations_in_d1,
    delete_filtered_recommendations,
    re_rank_recommendations,
    merge_llm_reasons_into_recommendations,
)
from services.llm_reason import generate_recommendation_reasons
from services.sector_flow_service import run_sector_flow_pipeline
from services.persona_service import (
    ChipBar,
    MarginBar,
    PersonaOpinions,
    compute_trust_opinion,
    compute_retail_opinion,
    write_opinions as write_persona_opinions,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# State schema — typed, contains domain data (not just step_status)
# ─────────────────────────────────────────────────────────────────────────────

class PipelineStateV2(TypedDict, total=False):
    """
    Full pipeline state. Each node reads relevant fields and returns an update dict.
    LangGraph reducer merges updates back into state automatically.
    """
    run_date: str

    # Loaded inputs
    active_stocks: list[dict]              # from D1 stocks WHERE in_current_watchlist=1
    screener_recs: list[dict]              # from D1 daily_recommendations (existing chip+tech)
    market_env: dict                        # market_risk + twii + breadth + us + history
    adaptive_params: dict                   # from KV ml:adaptive_params
    barrier_params: dict                    # from KV trading:config.barrier
    lifecycle_weights: dict                 # from model_pool.json
    trading_config: dict                    # B12 fix: full KV trading:config (sltp/signal/circuit)

    # Computed
    payloads: list[dict]                    # PredictPayload as dict
    predictions: dict                       # symbol → ml result
    final_recommendations: list[dict]       # after filter + scoring + ranking
    sell_filtered_symbols: list[str]        # symbols dropped due to SELL/NO_SIGNAL
    llm_reasons: dict                       # symbol → {reason, watchPoints}

    # Outputs
    sector_flow_summary: dict               # Phase 6: RRG compute result (concept + industry)
    persona_opinions: dict                  # symbol → {trust:{...}, retail:{...}} (Taiwan-persona augmentation)
    metrics: dict                           # timing, counts
    errors: Annotated[list[str], operator.add]


# ─────────────────────────────────────────────────────────────────────────────
# Nodes
# ─────────────────────────────────────────────────────────────────────────────

async def node_load_inputs(state: PipelineStateV2) -> dict:
    """
    Load active_stocks + existing screener_recs from D1.
    """
    logger.info("[Pipeline V2] node_load_inputs")
    run_date = state["run_date"]

    execution_stocks = load_active_stocks()
    screener_recs = d1_client.query(
        "SELECT * FROM daily_recommendations WHERE date = ? ORDER BY rank",
        [run_date],
    )
    active_stocks = build_ml_universe(execution_stocks, screener_recs)

    logger.info(
        f"[Pipeline V2] Loaded {len(active_stocks)} ML universe stocks "
        f"({len(execution_stocks)} execution), "
        f"{len(screener_recs)} existing screener_recs"
    )
    return {
        "active_stocks": active_stocks,
        "screener_recs": screener_recs,
    }


async def node_load_market_env(state: PipelineStateV2) -> dict:
    """
    Load shared market data + adaptive_params + barrier_params + lifecycle_weights.
    """
    logger.info("[Pipeline V2] node_load_market_env")
    market_env, adaptive, barrier, lifecycle, trading_cfg = load_market_env(state["run_date"])
    return {
        "market_env": _to_dict(market_env),
        "adaptive_params": adaptive,
        "barrier_params": barrier,
        "lifecycle_weights": lifecycle,
        "trading_config": trading_cfg,  # B12 fix: forward to ml_predict
    }


async def node_build_payloads(state: PipelineStateV2) -> dict:
    """
    Build PredictPayload list for all active stocks (bulk D1 reads).
    """
    logger.info("[Pipeline V2] node_build_payloads")
    from services.payload_builder import MarketEnv

    # Reconstruct MarketEnv from dict
    me_dict = state["market_env"]
    market_env = MarketEnv(**{k: v for k, v in me_dict.items() if k in MarketEnv.__dataclass_fields__})

    payloads = build_payloads(
        active_stocks=state["active_stocks"],
        market_env=market_env,
        adaptive_params=state.get("adaptive_params") or {},
        barrier_params=state.get("barrier_params") or {},
        lifecycle_weights=state.get("lifecycle_weights") or {},
        trading_config=state.get("trading_config") or {},
    )
    payloads_dict = [_to_dict(p) for p in payloads]
    return {"payloads": payloads_dict}


async def node_ml_predict(state: PipelineStateV2) -> dict:
    """
    Single batch_predict call — modal.map() (or httpx parallel concurrency=20).
    No serial sub-batching: all stocks at once, controller-side parallel.

    2026-04-19 ML_POOL Stage 0.1+0.2+0.3 + A:
    - Parallel batch: 5 feature models + Chronos + DLinear + PatchTST.
    - Per-stock merged signal: time_series → rank via sigmoid, weighted by
      ic_weights × lifecycle_weights from model_pool.json.
    - Original signal preserved as r["signal"] for backward compat;
      merged exposed as r["ensemble_v2"] = {avg_rank, signal, contributing_models}.
    """
    import asyncio
    import json as _json
    import math
    from services import modal_client

    payloads = state["payloads"]
    n = len(payloads)
    logger.info(f"[Pipeline V2] node_ml_predict: {n} stocks (batch feature models + Chronos)")

    if not payloads:
        return {"predictions": {}}

    # Build Chronos series_list once (close prices per symbol) to run in parallel
    # with feature-model batch predict. Uses last 512 values max — Chronos T5
    # context limit. Failed rows get error dict from chronos_universal.
    chronos_series = []
    for p in payloads:
        sym = p.get("symbol") if isinstance(p, dict) else None
        prices = p.get("prices") or [] if isinstance(p, dict) else []
        closes = [float(px.get("close", 0) or 0) for px in prices if px.get("close") is not None]
        if sym and closes:
            chronos_series.append({"symbol": sym, "prices": closes})

    # Parallel: alpha predictors + state overlays.
    # Kalman/Markov are state overlays only; they do not enter alpha challenger.
    model_status, active_versions, challenger_versions, pool_versions_loaded = await asyncio.to_thread(_load_model_pool_versions)

    async def _skip_batch(reason: str) -> dict:
        return {"error": reason, "results": []}

    feat_task = batch_predict(payloads)
    chronos_task = (
        modal_client.chronos_batch_predict(chronos_series, horizon=5, num_samples=20)
        if model_status.get("Chronos", "active") in ("active", "degraded")
        else _skip_batch("Chronos retired by model_pool")
    )
    dlinear_task = (
        modal_client.dlinear_batch_predict(chronos_series, horizon_used=5, version=active_versions.get("DLinear", "v1"))
        if model_status.get("DLinear", "active") in ("active", "degraded")
        else _skip_batch("DLinear retired by model_pool")
    )
    patchtst_task = (
        modal_client.patchtst_batch_predict(chronos_series, horizon_used=5, version=active_versions.get("PatchTST", "v1"))
        if model_status.get("PatchTST", "active") in ("active", "degraded")
        else _skip_batch("PatchTST retired by model_pool")
    )
    kalman_task = (
        modal_client.kalman_batch_predict(chronos_series, horizon=5, version=active_versions.get("KalmanFilter", "v1"))
        if model_status.get("KalmanFilter", "active") in ("active", "degraded")
        else _skip_batch("KalmanFilter retired by model_pool")
    )
    markov_task = (
        modal_client.markov_switching_batch_predict(chronos_series, horizon=5, version=active_versions.get("MarkovSwitching", "v1"))
        if model_status.get("MarkovSwitching", "active") in ("active", "degraded")
        else _skip_batch("MarkovSwitching retired by model_pool")
    )
    dlinear_ch_task = (
        modal_client.dlinear_batch_predict(chronos_series, horizon_used=5, version=challenger_versions["DLinear"])
        if challenger_versions.get("DLinear")
        else _skip_batch("DLinear challenger absent")
    )
    patchtst_ch_task = (
        modal_client.patchtst_batch_predict(chronos_series, horizon_used=5, version=challenger_versions["PatchTST"])
        if challenger_versions.get("PatchTST")
        else _skip_batch("PatchTST challenger absent")
    )
    (
        results,
        chronos_raw,
        dlinear_raw,
        patchtst_raw,
        kalman_raw,
        markov_raw,
        dlinear_ch_raw,
        patchtst_ch_raw,
    ) = await asyncio.gather(
        feat_task,
        chronos_task,
        dlinear_task,
        patchtst_task,
        kalman_task,
        markov_task,
        dlinear_ch_task,
        patchtst_ch_task,
        return_exceptions=True,
    )

    # Guard against Chronos total failure (don't let it block feature preds)
    chronos_map: dict[str, dict] = {}
    if isinstance(chronos_raw, BaseException):
        logger.warning(f"[Pipeline V2] Chronos batch failed entirely: {chronos_raw} — skipping Chronos layer")
    elif isinstance(chronos_raw, dict) and not chronos_raw.get("error"):
        for cr in chronos_raw.get("results") or []:
            sym = cr.get("symbol")
            if sym and not cr.get("error"):
                chronos_map[sym] = cr
        logger.info(
            f"[Pipeline V2] Chronos universal: {len(chronos_map)}/{len(chronos_series)} succeeded"
        )
    elif isinstance(chronos_raw, dict) and chronos_raw.get("results") == []:
        logger.debug(f"[Pipeline V2] Chronos skipped: {chronos_raw.get('error')}")
    else:
        logger.warning(f"[Pipeline V2] Chronos batch returned error: {chronos_raw}")

    # Guard against DLinear total failure (Stage 0.2 — may have no trained weights yet)
    dlinear_map: dict[str, dict] = {}
    if isinstance(dlinear_raw, BaseException):
        logger.warning(f"[Pipeline V2] DLinear batch failed entirely: {dlinear_raw} — skipping DLinear layer")
    elif isinstance(dlinear_raw, dict) and not dlinear_raw.get("error"):
        for dr in dlinear_raw.get("results") or []:
            sym = dr.get("symbol")
            if sym and not dr.get("error"):
                dlinear_map[sym] = dr
        if dlinear_map:
            logger.info(
                f"[Pipeline V2] DLinear universal: {len(dlinear_map)}/{len(chronos_series)} succeeded"
            )
        else:
            logger.info("[Pipeline V2] DLinear universal: 0 succeeded (likely no trained weights in GCS yet)")
    elif isinstance(dlinear_raw, dict) and dlinear_raw.get("results") == []:
        logger.debug(f"[Pipeline V2] DLinear skipped: {dlinear_raw.get('error')}")
    else:
        logger.warning(f"[Pipeline V2] DLinear batch returned error: {dlinear_raw}")

    # Guard against PatchTST total failure (Stage 0.3 — may have no trained weights yet)
    patchtst_map: dict[str, dict] = {}
    if isinstance(patchtst_raw, BaseException):
        logger.warning(f"[Pipeline V2] PatchTST batch failed entirely: {patchtst_raw} — skipping PatchTST layer")
    elif isinstance(patchtst_raw, dict) and not patchtst_raw.get("error"):
        for pr in patchtst_raw.get("results") or []:
            sym = pr.get("symbol")
            if sym and not pr.get("error"):
                patchtst_map[sym] = pr
        if patchtst_map:
            logger.info(
                f"[Pipeline V2] PatchTST universal: {len(patchtst_map)}/{len(chronos_series)} succeeded"
            )
        else:
            logger.info("[Pipeline V2] PatchTST universal: 0 succeeded (likely no trained weights in GCS yet)")
    elif isinstance(patchtst_raw, dict) and patchtst_raw.get("results") == []:
        logger.debug(f"[Pipeline V2] PatchTST skipped: {patchtst_raw.get('error')}")
    else:
        logger.warning(f"[Pipeline V2] PatchTST batch returned error: {patchtst_raw}")

    def _drain_ts_result(raw, name: str, series: list[dict]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        if isinstance(raw, BaseException):
            logger.warning(f"[Pipeline V2] {name} batch failed entirely: {raw}")
            return out
        if isinstance(raw, dict) and not raw.get("error"):
            for row in raw.get("results") or []:
                sym = row.get("symbol")
                if sym and not row.get("error"):
                    out[sym] = row
            logger.info(f"[Pipeline V2] {name}: {len(out)}/{len(series)} succeeded")
        elif isinstance(raw, dict) and raw.get("results") == []:
            logger.debug(f"[Pipeline V2] {name} skipped: {raw.get('error')}")
        else:
            logger.warning(f"[Pipeline V2] {name} batch returned error: {raw}")
        return out

    # Stage 6.2: KalmanFilter + MarkovSwitching state-space (per-stock loop, shared hyperparams)
    def _drain_state_space(raw, name: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        if isinstance(raw, BaseException):
            logger.warning(f"[Pipeline V2] {name} batch failed: {raw}")
            return out
        if isinstance(raw, dict) and not raw.get("error"):
            for r in raw.get("results") or []:
                sym = r.get("symbol")
                if sym and not r.get("error"):
                    out[sym] = r
            logger.info(f"[Pipeline V2] {name}: {len(out)}/{len(chronos_series)} succeeded")
        elif isinstance(raw, dict) and raw.get("results") == []:
            logger.debug(f"[Pipeline V2] {name} skipped: {raw.get('error')}")
        else:
            logger.warning(f"[Pipeline V2] {name} batch returned error: {raw}")
        return out
    kalman_map = _drain_state_space(kalman_raw, "KalmanFilter")
    markov_map = _drain_state_space(markov_raw, "MarkovSwitching")

    dlinear_ch_map = _drain_ts_result(dlinear_ch_raw, "DLinear::challenger", chronos_series)
    patchtst_ch_map = _drain_ts_result(patchtst_ch_raw, "PatchTST::challenger", chronos_series)

    # Guard against feature batch total failure
    if isinstance(results, BaseException):
        logger.error(f"[Pipeline V2] Feature batch_predict failed: {results}")
        return {"predictions": {}}

    def _attach_alt_sources(row: dict, sym: str) -> None:
        if sym in chronos_map:
            row["chronos"] = chronos_map[sym]
        if sym in dlinear_map:
            row["dlinear"] = dlinear_map[sym]
        if sym in patchtst_map:
            row["patchtst"] = patchtst_map[sym]
        if sym in kalman_map:
            row["kalman_filter"] = kalman_map[sym]
        if sym in markov_map:
            row["markov_switching"] = markov_map[sym]

    def _attach_challenger_shadow(row: dict, sym: str) -> None:
        challenger_scores = row.setdefault("challenger_rank_scores", {})
        if sym in dlinear_ch_map and dlinear_ch_map[sym].get("forecast_pct") is not None:
            challenger_scores["DLinear"] = _ts_to_rank(float(dlinear_ch_map[sym]["forecast_pct"]))
        if sym in patchtst_ch_map and patchtst_ch_map[sym].get("forecast_pct") is not None:
            challenger_scores["PatchTST"] = _ts_to_rank(float(patchtst_ch_map[sym]["forecast_pct"]))
        if not challenger_scores:
            row.pop("challenger_rank_scores", None)

    def _last_close(payload: dict) -> float:
        prices = payload.get("prices") or []
        if prices:
            return float(prices[-1].get("close") or prices[-1].get("adj_close") or 0.0)
        return 0.0

    def _signal_from_forecast(forecast_pct: float) -> str:
        if forecast_pct >= 0.03:
            return "STRONG_BUY"
        if forecast_pct >= 0.01:
            return "BUY"
        if forecast_pct <= -0.03:
            return "STRONG_SELL"
        if forecast_pct <= -0.01:
            return "SELL"
        return "HOLD"

    def _build_alt_only_prediction(sym: str, payload: dict, feature_error: str | None) -> dict | None:
        sources = [
            ("Chronos", chronos_map.get(sym)),
            ("DLinear", dlinear_map.get(sym)),
            ("PatchTST", patchtst_map.get(sym)),
        ]
        usable = [(name, row) for name, row in sources if row and row.get("forecast_pct") is not None]
        if not usable:
            return None

        forecasts = [float(row["forecast_pct"]) for _, row in usable]
        forecast_pct = sum(forecasts) / len(forecasts)
        confidence_values = [
            float(row.get("confidence"))
            for _, row in usable
            if row.get("confidence") is not None
        ]
        confidence = (
            sum(confidence_values) / len(confidence_values)
            if confidence_values
            else min(0.75, 0.5 + abs(forecast_pct) * 4.0)
        )
        current_price = _last_close(payload)
        atr = current_price * 0.02 if current_price > 0 else 0.0
        upside = max(0.01, forecast_pct)
        downside = max(0.03, abs(forecast_pct) * 0.75)

        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": sym,
            "current_price": current_price,
            "signal": _signal_from_forecast(forecast_pct),
            "direction": "up" if forecast_pct > 0 else "down" if forecast_pct < 0 else "neutral",
            "confidence": round(max(0.0, min(1.0, confidence)), 4),
            "consensus": len(usable),
            "forecast_pct": round(forecast_pct, 6),
            "forecast_range": [round(min(forecasts), 6), round(max(forecasts), 6)],
            "signal_strength": round(abs(forecast_pct), 6),
            "reasoning": "Feature-model fallback: alternate alpha time-series models available",
            "entry_price": round(current_price, 2) if current_price > 0 else None,
            "stop_loss": round(current_price * (1 - downside), 2) if current_price > 0 else None,
            "target1": round(current_price * (1 + max(0.03, upside)), 2) if current_price > 0 else None,
            "target2": round(current_price * (1 + max(0.06, upside * 1.8)), 2) if current_price > 0 else None,
            "models": [name for name, _ in usable],
            "features_used": [],
            "feature_version": "alternate_only_fallback",
            "rank_scores": {},
            "model_errors": [feature_error] if feature_error else None,
        }

    feature_by_symbol: dict[str, dict] = {}
    feature_errors_by_symbol: dict[str, str] = {}
    for row in results:
        sym = row.get("symbol")
        if not sym:
            continue
        if row.get("error"):
            feature_errors_by_symbol[sym] = str(row.get("error"))
            continue
        feature_by_symbol[sym] = row

    pred_map: dict[str, dict] = {}
    alt_fallback_count = 0
    for payload in payloads:
        sym = payload.get("symbol") if isinstance(payload, dict) else None
        if not sym:
            continue
        row = feature_by_symbol.get(sym)
        if row is None:
            row = _build_alt_only_prediction(sym, payload, feature_errors_by_symbol.get(sym))
            if row is None:
                continue
            alt_fallback_count += 1
        if isinstance(payload, dict):
            row["stock_meta"] = payload.get("stock_meta") or {}
        _attach_alt_sources(row, sym)
        _attach_challenger_shadow(row, sym)
        pred_map[sym] = row

    degenerate_scores = drop_degenerate_rank_scores(pred_map, score_field="rank_scores")
    degenerate_challengers = drop_degenerate_rank_scores(pred_map, score_field="challenger_rank_scores")
    if degenerate_scores:
        logger.warning(f"[Pipeline V2] Dropped degenerate active rank_scores: {degenerate_scores}")
    if degenerate_challengers:
        logger.warning(f"[Pipeline V2] Dropped degenerate challenger rank_scores: {degenerate_challengers}")

    error_count = sum(1 for r in results if r.get("error"))
    if error_count:
        sample_errors = [
            f"{sym}: {err}" for sym, err in list(feature_errors_by_symbol.items())[:5]
        ]
        logger.warning(f"[Pipeline V2] Feature batch returned {error_count} row errors; sample={sample_errors}")
    logger.info(
        f"[Pipeline V2] ML predict done: {len(pred_map)}/{n} succeeded, "
        f"{error_count} errors, chronos={sum(1 for v in pred_map.values() if 'chronos' in v)}, "
        f"dlinear={sum(1 for v in pred_map.values() if 'dlinear' in v)}, "
        f"patchtst={sum(1 for v in pred_map.values() if 'patchtst' in v)}, "
        f"kalman={sum(1 for v in pred_map.values() if 'kalman_filter' in v)}, "
        f"markov={sum(1 for v in pred_map.values() if 'markov_switching' in v)}, "
        f"alt_fallback={alt_fallback_count}, "
        f"pool_versions={'ok' if pool_versions_loaded else 'fallback'}, "
        f"challenger_shadow={sum(1 for v in pred_map.values() if v.get('challenger_rank_scores'))}"
    )

    # ── A: ML_POOL ensemble merge (5 feature + 3 time-series with lifecycle) ──
    # 2026-04-19 R1+R3 hybrid: weight = max(0, ic) × status_filter × dampening.
    # No more hardcoded 0.1 degraded multiplier; pure IC drives weight, with
    # KV-overridable dampening for degraded models (default 1.0 = no dampening).
    model_status, ic_universe, degraded_dampening, ev2_cfg, used_pool = await asyncio.to_thread(_load_pool_and_ic)
    if used_pool:
        for sym, r in pred_map.items():
            try:
                _attach_ensemble_v2(r, model_status, ic_universe, degraded_dampening, ev2_cfg)
            except Exception as e:
                logger.debug(f"[Pipeline V2] ensemble_v2 merge failed for {sym}: {e}")
        logger.info(
            f"[Pipeline V2] Ensemble V2 merged: {sum(1 for v in pred_map.values() if 'ensemble_v2' in v)}/{len(pred_map)} stocks "
            f"(degraded_dampening={degraded_dampening})"
        )

        # #B Option 1 Top-K override (2026-04-21): regression-on-rank predictions
        # compress to [0.43, 0.58] under realistic R² 0.02-0.05, never hitting
        # absolute 0.70 BUY threshold. Industry-standard fix: sort top K by
        # avg_rank desc, force BUY regardless of absolute threshold. Confidence
        # override gives downstream (paper.ts morning-setup SQL + debate prompt)
        # the margin they need to distinguish promoted signals from edge HOLDs.
        top_k_enabled = bool(ev2_cfg.get("topKOverrideEnabled", True))
        top_k_count = int(ev2_cfg.get("topKCount", 3))
        top_k_conf = float(ev2_cfg.get("topKConfidenceOverride", 0.72))
        if top_k_enabled and top_k_count > 0:
            ranked = sorted(
                ((sym, v) for sym, v in pred_map.items() if "ensemble_v2" in v),
                key=lambda kv: kv[1]["ensemble_v2"].get("avg_rank", 0.0),
                reverse=True,
            )
            forced: list[str] = []
            for sym, v in ranked[:top_k_count]:
                ev2 = v["ensemble_v2"]
                cur = ev2.get("signal")
                if cur in ("BUY", "STRONG_BUY"):
                    continue  # natural buy signal; leave as-is
                ev2["signal_raw"] = cur  # preserve pre-override for audit
                ev2["signal_source_raw"] = ev2.get("signal_source", "ensemble_v2")
                ev2["signal"] = "BUY"
                ev2["confidence_override"] = top_k_conf
                ev2["confidence"] = max(float(ev2.get("confidence", 0.0) or 0.0), top_k_conf)
                ev2["signal_source"] = "ensemble_v2_topk_policy"
                ev2["topk_forced"] = True
                forced.append(sym)
            if forced:
                logger.info(
                    f"[Pipeline V2] ensemble_v2 top-K override forced BUY on "
                    f"{len(forced)}/{top_k_count} stocks (conf={top_k_conf}): {forced}"
                )
    else:
        logger.info("[Pipeline V2] Ensemble V2 skip (model_pool.json not initialized)")

    return {"predictions": pred_map}


# ─────────────────────────────────────────────────────────────────────────────
# A: ML_POOL-aware ensemble merge helpers (pure Python, no Modal)
# ─────────────────────────────────────────────────────────────────────────────


def _load_model_pool_versions() -> tuple[dict[str, str], dict[str, str], dict[str, str], bool]:
    """Load active/challenger versions for batch predictors.

    Returns (status_by_model, active_version_by_model, challenger_version_by_model, used_pool).
    Missing pool falls back to v1 active behavior.
    """
    import json as _json
    import os

    active_defaults = {
        "DLinear": "v1",
        "PatchTST": "v1",
        "KalmanFilter": "v1",
        "MarkovSwitching": "v1",
    }
    try:
        from google.cloud import storage

        bucket_name = os.getenv("GCS_BUCKET_NAME")
        if not bucket_name:
            return {}, active_defaults, {}, False
        blob = storage.Client().bucket(bucket_name).blob("universal/model_pool.json")
        if not blob.exists():
            return {}, active_defaults, {}, False

        pool = _json.loads(blob.download_as_text())
        status: dict[str, str] = {}
        active_versions = dict(active_defaults)
        challenger_versions: dict[str, str] = {}
        for name, entry in (pool.get("models") or {}).items():
            status[name] = entry.get("status", "active")
            if entry.get("status", "active") in ("active", "degraded") and entry.get("version"):
                active_versions[name] = entry["version"]
            challenger = entry.get("challenger") or {}
            if challenger.get("version"):
                challenger_versions[name] = challenger["version"]
        for name, entry in (pool.get("state_overlays") or {}).items():
            status[name] = entry.get("status", "active")
            if entry.get("status", "active") in ("active", "degraded") and entry.get("version"):
                active_versions[name] = entry["version"]
        return status, active_versions, challenger_versions, True
    except Exception as e:
        logger.warning(f"[Pipeline V2] model_pool version load failed: {e}")
        return {}, active_defaults, {}, False


def _load_pool_and_ic():
    """Synchronous loader (called via asyncio.to_thread).

    Returns:
      (model_status, ic_weights, degraded_dampening, ev2_cfg, used_pool)

    2026-04-19 R1+R3 hybrid:
      - model_status: per-model "active"/"degraded"/"challenger"/"retired"
      - ic_weights: from model_pool.json rolling_ic/ic_4w_avg/latest weekly_ic
      - degraded_dampening: from trading:config.mlPool.degradedDampening
      - ev2_cfg: from trading:config.ensemble_v2 — thresholds + Top-K override
        config (#B Option 1 2026-04-21 fix for "bot no-buy" mystery). Empty
        dict when KV absent → _attach_ensemble_v2 + top-K loop fall back to
        hardcoded defaults matching ml-service ensemble.rank_to_signal.
    """
    import json as _json
    import os
    try:
        from google.cloud import storage
        bucket_name = os.getenv("GCS_BUCKET_NAME")
        if not bucket_name:
            logger.warning("[Pipeline V2] GCS_BUCKET_NAME not set; skip model pool / IC load")
            return {}, {}, 1.0, {}, False
        bucket = storage.Client().bucket(bucket_name)
        pool_blob = bucket.blob("universal/model_pool.json")
        if not pool_blob.exists():
            return {}, {}, 1.0, {}, False
        pool = _json.loads(pool_blob.download_as_text())
        model_status: dict[str, str] = {}
        ic_weights: dict[str, float] = {}
        for name, entry in pool.get("models", {}).items():
            model_status[name] = entry.get("status", "active")
            ic_value = entry.get("rolling_ic")
            if ic_value is None:
                ic_value = entry.get("ic_4w_avg")
            if ic_value is None:
                history = entry.get("weekly_ic") or []
                if history:
                    ic_value = history[-1]
            try:
                if ic_value is not None:
                    ic_weights[name] = float(ic_value)
            except (TypeError, ValueError):
                logger.debug(f"[Pipeline V2] invalid model_pool IC for {name}: {ic_value}")

        # Legacy sidecar fallback only fills models that model_pool cannot yet score.
        ic_blob = bucket.blob("universal/ic_tracking.json")
        if ic_blob.exists():
            ic_data = _json.loads(ic_blob.download_as_text())
            for name, info in (ic_data.get("models") or {}).items():
                if name in ic_weights:
                    continue
                ic_weights[name] = float(info.get("oos_ic", 0.0))
        # KV-driven degraded dampening + ensemble_v2 thresholds / Top-K cfg
        degraded_dampening = 1.0
        ev2_cfg: dict = {}
        try:
            from services import kv_client
            tcfg = kv_client.get_json("trading:config", default={}) or {}
            ml_pool_cfg = tcfg.get("mlPool", {}) or {}
            degraded_dampening = float(ml_pool_cfg.get("degradedDampening", 1.0))
            ev2_cfg = tcfg.get("ensemble_v2", {}) or {}
        except Exception as _e:
            logger.debug(f"[Pipeline V2] trading:config KV lookup failed (using defaults): {_e}")
        return model_status, ic_weights, degraded_dampening, ev2_cfg, True
    except Exception as e:
        logger.warning(f"[Pipeline V2] _load_pool_and_ic failed: {e}")
        return {}, {}, 1.0, {}, False


def _ts_to_rank(forecast_pct: float, scale: float = 12.0) -> float:
    """Sigmoid map for time-series forecast → rank-like 0~1 (mirror of
    ml-service ensemble.time_series_to_rank)."""
    import math
    return 1.0 / (1.0 + math.exp(-forecast_pct * scale))


def _attach_ensemble_v2(
    pred: dict,
    model_status: dict,
    ic_weights: dict,
    degraded_dampening: float,
    ev2_cfg: dict | None = None,
) -> None:
    attach_ensemble_v2(pred, model_status, ic_weights, degraded_dampening, ev2_cfg)

async def node_compute_personas(state: PipelineStateV2) -> dict:
    """
    Taiwan-persona augmentation layer (投信 + 散戶 contrarian).

    For each active stock with a payload, compute two opinions using
    chip_data (trust_net) and margin_data (margin_balance) already loaded
    into the payload, plus concept-level PTT sentiment via stock_tags →
    concept_buzz.

    Written to persona_opinions D1 table AND returned in state for the
    recommendation node (Phase 2 score integration).

    Non-fatal: failures log a warning but do not block the pipeline.
    """
    logger.info("[Pipeline V2] node_compute_personas")
    run_date = state["run_date"]
    payloads = state.get("payloads") or []
    if not payloads:
        return {"persona_opinions": {}}

    # ── Bulk-load concept sentiment: symbol → best_concept → sentiment_avg ──
    # One query each for tags + buzz, then join in memory. Keeps D1 QPS low.
    symbols = [p.get("stock_id") or p.get("symbol") for p in payloads]
    symbols = [s for s in symbols if s]
    sentiment_by_symbol: dict[str, float] = {}
    try:
        # Top concept per symbol (highest weight)
        placeholders = ",".join("?" * len(symbols))
        tag_rows = d1_client.query(
            f"SELECT symbol, tag FROM stock_tags WHERE symbol IN ({placeholders}) "
            f"ORDER BY symbol, weight DESC",
            list(symbols),
        )
        top_concept_by_symbol: dict[str, str] = {}
        for r in tag_rows or []:
            sym = r.get("symbol")
            if sym and sym not in top_concept_by_symbol:
                top_concept_by_symbol[sym] = r.get("tag")

        # Today's concept_buzz sentiment for those concepts
        concepts = list({c for c in top_concept_by_symbol.values() if c})
        if concepts:
            cp_placeholders = ",".join("?" * len(concepts))
            buzz_rows = d1_client.query(
                f"SELECT concept, sentiment_avg FROM concept_buzz "
                f"WHERE date = ? AND concept IN ({cp_placeholders})",
                [run_date, *concepts],
            )
            sent_by_concept: dict[str, float] = {}
            for r in buzz_rows or []:
                c = r.get("concept")
                s = r.get("sentiment_avg")
                if c is not None and s is not None:
                    sent_by_concept[c] = float(s)
            for sym, concept in top_concept_by_symbol.items():
                if concept in sent_by_concept:
                    sentiment_by_symbol[sym] = sent_by_concept[concept]
    except Exception as e:
        logger.warning(f"[Pipeline V2] persona sentiment lookup failed (non-fatal): {e}")

    # ── Compute per-symbol opinions ─────────────────────────────────────────
    from datetime import date as _date
    try:
        today_dt = _date.fromisoformat(run_date)
    except Exception:
        today_dt = _date.today()

    opinions: list[PersonaOpinions] = []
    opinions_dict: dict[str, dict] = {}
    for p in payloads:
        sym = p.get("stock_id") or p.get("symbol")
        if not sym:
            continue
        chips = p.get("chips") or []
        if not chips:
            continue

        chip_bars: list[ChipBar] = []
        margin_bars: list[MarginBar] = []
        for row in chips:
            d = row.get("date")
            if not d:
                continue
            tn = row.get("trust_net")
            if tn is not None:
                chip_bars.append(ChipBar(date=str(d), trust_net=float(tn)))
            mb = row.get("margin_balance")
            if mb is not None:
                margin_bars.append(MarginBar(date=str(d), margin_balance=float(mb)))

        sentiment = sentiment_by_symbol.get(sym)

        try:
            trust = compute_trust_opinion(chip_bars, today_dt)
            retail = compute_retail_opinion(margin_bars, sentiment)
        except Exception as e:
            logger.warning(f"[Pipeline V2] persona compute failed for {sym}: {e}")
            continue

        opinions.append(PersonaOpinions(
            symbol=sym, date=run_date, trust=trust, retail=retail,
        ))
        opinions_dict[sym] = {
            "trust": trust.to_dict(),
            "retail": retail.to_dict(),
        }

    # ── Persist to D1 (non-fatal) ───────────────────────────────────────────
    try:
        written = write_persona_opinions(d1_client, opinions)
        logger.info(f"[Pipeline V2] persona opinions written: {written}/{len(opinions)}")
    except Exception as e:
        logger.warning(f"[Pipeline V2] persona D1 write failed (non-fatal): {e}")

    return {"persona_opinions": opinions_dict}


async def node_compute_sector_flow(state: PipelineStateV2) -> dict:
    """
    Phase 6: Compute RRG (rs_ratio / rs_momentum / quadrant) for concept + industry
    and upsert into sector_flow. Must run before node_recommend because downstream
    hybrid ranking + paper.ts T2 quadrant filter depend on fresh sector_flow rows.

    Runs sync work in a thread to avoid blocking the event loop (d1_client is sync).
    """
    logger.info("[Pipeline V2] node_compute_sector_flow")
    run_date = state["run_date"]
    try:
        summary = await asyncio.to_thread(run_sector_flow_pipeline, run_date)
        return {"sector_flow_summary": summary}
    except Exception as e:
        logger.error(f"[Pipeline V2] sector_flow failed (non-fatal): {e}")
        return {"sector_flow_summary": {}, "errors": [f"sector_flow: {e}"]}


async def node_recommend(state: PipelineStateV2) -> dict:
    """
    Filter SELL, compute ml_score + persona_score, hybrid ranking promotion.
    """
    logger.info("[Pipeline V2] node_recommend")

    # Phase 2: persona weight is KV-controllable for safe rollout
    #   ml:persona_score_weight — float, default 1.0, 0 = disabled, 0.5 = shadow
    try:
        persona_weight = float(
            kv_client.get_json("ml:persona_score_weight", default=1.0) or 1.0
        )
    except Exception:
        persona_weight = 1.0
    persona_weight = max(0.0, min(2.0, persona_weight))  # clamp [0, 2] safety bound
    try:
        regime_label = kv_client.get("ml:regime")
    except Exception:
        regime_label = None
    try:
        regime_meta = kv_client.get_json("ml:regime:meta", default={}) or {}
        regime_surface = (
            regime_meta.get("regime_surface")
            or regime_meta.get("regime_probabilities")
            or regime_meta.get("probabilities")
            or {}
        )
    except Exception:
        regime_surface = {}

    trading_cfg = kv_client.get_json("trading:config", default={}) or {}
    alpha_policy = trading_cfg.get("alphaFramework", {}) or trading_cfg.get("alpha_framework", {}) or {}
    screener_recs = state["screener_recs"]
    if not screener_recs:
        screener_recs = build_screener_seed_recommendations(
            state.get("active_stocks") or [],
            state.get("payloads") or [],
            state["run_date"],
        )
        logger.info("[Pipeline V2] Screener seed fallback active: %s rows", len(screener_recs))

    final, sell_count = filter_and_score_recommendations(
        screener_recs,
        state["predictions"],
        state["payloads"],
        persona_opinions=state.get("persona_opinions") or {},
        persona_weight=persona_weight,
        regime_label=regime_label,
        regime_surface=regime_surface,
        alpha_policy=alpha_policy,
    )

    # Hybrid ranking from KV trading:config.ranking
    ranking_cfg = trading_cfg.get("ranking", {"enabled": True, "topK": 3,
                                              "alpha": 0.40, "beta": 0.40, "gamma": 0.20,
                                              "screenerDenominator": 60.0, "promoteMinConf": 0.60})
    ev2_cfg = trading_cfg.get("ensemble_v2", {}) or {}
    final = hybrid_ranking_promotion(
        final,
        ranking_cfg,
        ev2_cfg,
        regime_label=regime_label,
        regime_surface=regime_surface,
        alpha_policy=alpha_policy,
    )
    for row in final:
        allocation = row.get("alpha_allocation")
        symbol = row.get("symbol")
        if allocation and symbol in state["predictions"]:
            state["predictions"][symbol]["alpha_allocation"] = allocation

    # Track which symbols were filtered out (for D1 delete in write_d1)
    final_syms = {r["symbol"] for r in final}
    filtered_syms = [r["symbol"] for r in screener_recs if r["symbol"] not in final_syms]

    logger.info(
        f"[Pipeline V2] Recommend done: {len(final)} kept, {sell_count} SELL filtered"
    )
    return {
        "final_recommendations": final,
        "sell_filtered_symbols": filtered_syms,
    }


async def node_llm_reasons(state: PipelineStateV2) -> dict:
    """
    Generate LLM reasons via Anthropic API (non-blocking, fallback empty on fail).
    """
    logger.info("[Pipeline V2] node_llm_reasons")
    candidates = state["final_recommendations"]
    if not candidates:
        return {"llm_reasons": {}}

    # Top themes from sector_flow_summary (Phase 6 — node_compute_sector_flow populates)
    # Optional context for LLM prompt; empty list is acceptable fallback.
    top_themes: list[str] = []
    sf = state.get("sector_flow_summary") or {}
    # Summary carries counts only; LLM prompt enhancement can read D1 directly if needed.
    # Keep minimal for now to avoid extra D1 roundtrip in hot path.

    try:
        reasons = await generate_recommendation_reasons(candidates, top_themes=top_themes)
        return {"llm_reasons": reasons}
    except Exception as e:
        logger.error(f"[Pipeline V2] LLM reasons failed: {e}")
        return {"llm_reasons": {}, "errors": [f"llm_reasons: {e}"]}


async def node_write_d1(state: PipelineStateV2) -> dict:
    """
    Write predictions + update recommendations + delete SELL-filtered + re-rank.
    All in D1 batch_execute for atomicity.
    """
    logger.info("[Pipeline V2] node_write_d1")
    run_date = state["run_date"]

    # 1. Predictions
    stock_id_map = {s["symbol"]: s["id"] for s in state["active_stocks"]}
    predictions_written = write_predictions_to_d1(state["predictions"], stock_id_map, run_date)

    # 2. Merge LLM reasons into recommendations (overwrite template)
    final = state["final_recommendations"]
    merge_llm_reasons_into_recommendations(final, state.get("llm_reasons") or {})

    # 3. Update daily_recommendations
    rec_updated = update_recommendations_in_d1(final, run_date)

    # 4. Delete SELL-filtered rows
    sell_deleted = delete_filtered_recommendations(state.get("sell_filtered_symbols") or [], run_date)

    # 5. Re-rank
    re_rank_recommendations(run_date)
    alpha_bucket_counts: dict[str, int] = {}
    alpha_selected_bucket_counts: dict[str, int] = {}
    alpha_skip_count = 0
    for row in final:
        ctx = row.get("alpha_context") or {}
        bucket = ctx.get("edge_bucket")
        if bucket:
            alpha_bucket_counts[bucket] = alpha_bucket_counts.get(bucket, 0) + 1
        allocation = row.get("alpha_allocation") or {}
        allocation_bucket = allocation.get("bucket")
        if allocation.get("selected") and allocation_bucket:
            alpha_selected_bucket_counts[allocation_bucket] = alpha_selected_bucket_counts.get(allocation_bucket, 0) + 1
        if (ctx.get("risk_overlay") or {}).get("skip"):
            alpha_skip_count += 1

    metrics = {
        "predictions_written": predictions_written,
        "recommendations_updated": rec_updated,
        "sell_deleted": sell_deleted,
        "llm_reasons_count": len(state.get("llm_reasons") or {}),
        "alpha_bucket_counts": alpha_bucket_counts,
        "alpha_selected_bucket_counts": alpha_selected_bucket_counts,
        "alpha_skip_count": alpha_skip_count,
    }
    logger.info(f"[Pipeline V2] write_d1 done: {metrics}")
    return {"metrics": metrics}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _to_dict(obj: Any) -> dict:
    """Convert dataclass or dict to plain dict (for state serialization)."""
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "__dataclass_fields__"):
        from dataclasses import asdict
        return asdict(obj)
    return dict(obj) if obj else {}


# ─────────────────────────────────────────────────────────────────────────────
# Build graph
# ─────────────────────────────────────────────────────────────────────────────

_graph_singleton: Any = None


def build_graph():
    """Build and compile the LangGraph StateGraph."""
    g = StateGraph(PipelineStateV2)

    # 2026-04-08 P2: Retry policy for ml_predict — protects against transient
    # Modal infra failures (grpc disconnect, control plane hiccup). Per-task
    # timeouts are already caught per-item by P1 return_exceptions, so retry
    # only fires when batch_predict itself raises (rare).
    ml_retry = RetryPolicy(
        max_attempts=2,
        initial_interval=2.0,
        backoff_factor=2.0,
        jitter=True,
    )

    g.add_node("load_inputs",       node_load_inputs)
    g.add_node("load_market_env",   node_load_market_env)
    g.add_node("compute_sector_flow", node_compute_sector_flow)
    g.add_node("build_payloads",    node_build_payloads)
    g.add_node("ml_predict",        node_ml_predict, retry=ml_retry)
    g.add_node("compute_personas", node_compute_personas)
    g.add_node("recommend",         node_recommend)
    g.add_node("gen_llm_reasons",   node_llm_reasons)
    g.add_node("write_d1",          node_write_d1)

    # 2026-04-18 P2 #40: parallelize independent loaders.
    # load_market_env and compute_sector_flow are independent of each other
    # (and only need load_inputs.run_date which all nodes already have via state).
    # Fan-out from load_inputs → both run concurrently → fan-in at build_payloads.
    # Saves ~10-20s of sequential wait per pipeline.
    g.set_entry_point("load_inputs")
    g.add_edge("load_inputs",         "load_market_env")
    g.add_edge("load_inputs",         "compute_sector_flow")
    # Both load_market_env and compute_sector_flow converge at build_payloads.
    # LangGraph fan-in: build_payloads waits for both upstream nodes to complete.
    g.add_edge("load_market_env",     "build_payloads")
    g.add_edge("compute_sector_flow", "build_payloads")
    g.add_edge("build_payloads",      "ml_predict")
    g.add_edge("ml_predict",          "compute_personas")
    g.add_edge("compute_personas",    "recommend")
    g.add_edge("recommend",           "gen_llm_reasons")
    g.add_edge("gen_llm_reasons",     "write_d1")
    g.add_edge("write_d1",            END)

    # Checkpointer disabled for now:
    # - Local sqlite checkpointing is not durable in Cloud Run /tmp.
    # - langgraph-checkpoint-sqlite is intentionally not installed; adding it
    #   back would reintroduce an unused dependency owner and leave OSV debt.
    # - Cloud Run /tmp is ephemeral so checkpoint loses across restarts anyway
    # Phase 2 future: D1-backed AsyncSqliteSaver subclass for true resume support
    compiled = g.compile()
    logger.info("[Pipeline V2] Compiled without checkpointer (Cloud Run ephemeral /tmp)")
    return compiled


def get_graph():
    """Lazy singleton — build once per Cloud Run container."""
    global _graph_singleton
    if _graph_singleton is None:
        _graph_singleton = build_graph()
    return _graph_singleton


# ─────────────────────────────────────────────────────────────────────────────
# Public runner
# ─────────────────────────────────────────────────────────────────────────────

async def run_pipeline_v2(run_date: str = "") -> dict:
    """
    Execute the full pipeline V2.

    Args:
        run_date: TW date YYYY-MM-DD (default: today TW)

    Returns:
        {status, run_date, metrics, errors}
    """
    if not run_date:
        from datetime import datetime, timezone, timedelta
        tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
        run_date = tw_now.strftime("%Y-%m-%d")

    initial_state: PipelineStateV2 = {
        "run_date": run_date,
        "errors": [],
        "metrics": {},
    }

    logger.info(f"[Pipeline V2] Starting for {run_date}")
    t0 = asyncio.get_event_loop().time()

    graph = get_graph()
    try:
        # No checkpointer → no config needed
        final_state = await graph.ainvoke(initial_state)
        elapsed = asyncio.get_event_loop().time() - t0
        logger.info(f"[Pipeline V2] Completed in {elapsed:.1f}s: {final_state.get('metrics', {})}")
        return {
            "status": "completed",
            "run_date": run_date,
            "elapsed_s": round(elapsed, 1),
            "metrics": final_state.get("metrics", {}),
            "errors": final_state.get("errors", []),
        }
    except Exception as e:
        elapsed = asyncio.get_event_loop().time() - t0
        logger.exception(f"[Pipeline V2] Failed after {elapsed:.1f}s")
        return {
            "status": "error",
            "run_date": run_date,
            "elapsed_s": round(elapsed, 1),
            "error": str(e),
        }
