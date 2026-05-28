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
import json
import logging
import operator
import os
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, TypedDict

from langgraph.graph import StateGraph, END
from langgraph.types import RetryPolicy

from services import d1_client, kv_client
from services.ensemble_v2 import attach_ensemble_v2
from services.payload_builder import (
    DAILY_RECOMMENDATION_PIPELINE_COLUMNS,
    PredictPayload,
    load_market_env,
    build_payloads,
    build_ml_universe,
)
from services.modal_client import batch_predict
from services.model_score_quality import drop_degenerate_rank_scores
from services.market_regime_state import resolve_market_regime_contract
from services.prediction_dispersion import build_prediction_dispersion_report
from services.state_space_series import build_state_space_series_from_payloads
from services.recommendation_service import (
    filter_and_score_recommendations,
    hybrid_ranking_promotion,
    load_fundamental_quality_by_symbol,
    write_predictions_to_d1,
    prune_predictions_outside_universe,
    update_recommendations_in_d1,
    delete_filtered_recommendations,
    re_rank_recommendations,
    merge_breeze2_reason_shadow_into_score_components,
    merge_llm_reasons_into_recommendations,
)
from services.llm_reason import generate_recommendation_reasons
from services.breeze2_reason_shadow import (
    breeze2_reason_shadow_metrics,
    build_breeze2_generation_shadow_for_candidates,
    build_breeze2_reason_shadow_for_candidates,
)
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

D1_RETRY_DELAYS_SECONDS = (3.0, 8.0, 15.0)
D1_RETRYABLE_MARKERS = (
    "HTTP 429",
    "D1 DB is overloaded",
    "Requests queued for too long",
    "Too Many Requests",
)


def _is_retryable_d1_overload(error: Exception) -> bool:
    message = str(error)
    return any(marker.lower() in message.lower() for marker in D1_RETRYABLE_MARKERS)


async def _load_market_env_with_backoff(run_date: str):
    """Retry the hot-path market environment read when D1 is temporarily saturated."""
    for attempt in range(len(D1_RETRY_DELAYS_SECONDS) + 1):
        try:
            return await asyncio.to_thread(load_market_env, run_date)
        except Exception as exc:  # noqa: BLE001
            if attempt >= len(D1_RETRY_DELAYS_SECONDS) or not _is_retryable_d1_overload(exc):
                raise
            delay = D1_RETRY_DELAYS_SECONDS[attempt]
            logger.warning(
                "[Pipeline V2] load_market_env D1 overload attempt=%s/%s; retry in %.1fs: %s",
                attempt + 1,
                len(D1_RETRY_DELAYS_SECONDS) + 1,
                delay,
                exc,
            )
            await asyncio.sleep(delay)


def _truthy_env(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _state_space_overlay_mode() -> str:
    raw = (
        os.environ.get("PIPELINE_STATE_SPACE_OVERLAY_MODE")
        or os.environ.get("STATE_SPACE_OVERLAY_MODE")
        or "blocking"
    )
    mode = str(raw).strip().lower()
    if mode not in {"blocking", "shadow", "disabled"}:
        return "blocking"
    if mode in {"shadow", "disabled"} and not _truthy_env("PIPELINE_ALLOW_STATE_SPACE_OVERLAY_DEGRADE"):
        logger.warning(
            "[Pipeline V2] Refusing state-space overlay mode=%s without "
            "PIPELINE_ALLOW_STATE_SPACE_OVERLAY_DEGRADE=1; using blocking mode",
            mode,
        )
        return "blocking"
    return mode


def _breeze2_reason_shadow_enabled() -> bool:
    raw = os.environ.get("BREEZE2_REASON_SHADOW", "1")
    return str(raw).strip().lower() not in {"0", "false", "off", "disabled", "no"}


def _breeze2_reason_shadow_provider() -> str:
    provider = str(os.environ.get("BREEZE2_REASON_SHADOW_PROVIDER") or "context").strip().lower()
    return provider if provider in {"context", "modal_generation"} else "context"


# ─────────────────────────────────────────────────────────────────────────────
# State schema — typed, contains domain data (not just step_status)
# ─────────────────────────────────────────────────────────────────────────────

class PipelineStateV2(TypedDict, total=False):
    """
    Full pipeline state. Each node reads relevant fields and returns an update dict.
    LangGraph reducer merges updates back into state automatically.
    """
    run_date: str
    producer_run_id: str

    # Loaded inputs
    active_stocks: list[dict]              # from daily_recommendations V2 screener universe
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

    breeze2_reason_shadow: dict             # symbol -> advisory-only Breeze2 shadow reason

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

    screener_recs = d1_client.query(
        f"SELECT {DAILY_RECOMMENDATION_PIPELINE_COLUMNS} "
        "FROM daily_recommendations WHERE date = ? ORDER BY rank",
        [run_date],
    )
    if not screener_recs:
        raise RuntimeError(
            "screener_recs_missing: daily pipeline requires full-market screener "
            "seeds before ML/recommendation; refusing watchlist fallback"
        )
    active_stocks = build_ml_universe([], screener_recs)

    logger.info(
        f"[Pipeline V2] Loaded {len(active_stocks)} ML universe stocks "
        f"(source=daily_recommendations), "
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
    market_env, adaptive, barrier, lifecycle, trading_cfg = await _load_market_env_with_backoff(state["run_date"])
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
        as_of_date=state["run_date"],
    )
    payloads_dict = [_to_dict(p) for p in payloads]
    return {"payloads": payloads_dict}


async def node_ml_predict(state: PipelineStateV2) -> dict:
    """
    Single batch_predict call — modal.map() (or httpx parallel concurrency=20).
    No serial sub-batching: all stocks at once, controller-side parallel.

    2026-04-19 ML_POOL Stage 0.1+0.2+0.3 + A:
    - Parallel batch: feature models + DLinear + PatchTST.
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
    logger.info(f"[Pipeline V2] node_ml_predict: {n} stocks (batch feature models + DLinear/PatchTST)")

    if not payloads:
        return {"predictions": {}}

    # Build shared close-price series once for time-series predictors.
    chronos_series = build_state_space_series_from_payloads(payloads)

    # Parallel: alpha predictors + state overlays.
    # Kalman/Markov are state overlays only; they do not enter alpha challenger.
    model_status, active_versions, challenger_versions, pool_versions_loaded = await asyncio.to_thread(_load_model_pool_versions)

    async def _skip_batch(reason: str) -> dict:
        return {"error": reason, "results": []}

    feat_task = batch_predict(payloads)
    chronos_task = _skip_batch("Chronos retired from alpha vote and production evening-chain batch")
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
    state_space_mode = _state_space_overlay_mode()
    state_space_models = {
        model_name: active_versions.get(model_name, "v1")
        for model_name in ("KalmanFilter", "MarkovSwitching")
        if model_status.get(model_name, "active") in ("active", "degraded")
    }

    async def _shadow_state_space_overlays() -> dict:
        if not state_space_models:
            return {"error": "state-space overlays retired by model_pool", "results": []}
        if state_space_mode == "disabled":
            return {"error": "state-space overlays disabled by overlay mode", "results": []}
        if state_space_mode == "shadow":
            try:
                spawn_info = await asyncio.to_thread(
                    modal_client.spawn_state_space_overlays_batch_predict,
                    chronos_series,
                    horizon=5,
                    version_by_model=state_space_models,
                )
                logger.info(f"[Pipeline V2] State-space overlays shadow spawned: {spawn_info}")
                return {"error": "state-space overlays shadow spawned; not blocking prediction", "results": [], "shadow": spawn_info}
            except Exception as exc:  # noqa: BLE001 - shadow overlay must not block prediction.
                logger.warning(f"[Pipeline V2] State-space overlays shadow spawn failed: {exc}")
                return {"error": f"state-space overlays shadow spawn failed: {exc}", "results": []}
        return await modal_client.state_space_overlays_batch_predict(
            chronos_series,
            horizon=5,
            version_by_model=state_space_models,
        )

    state_space_task = _shadow_state_space_overlays()
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
        state_space_raw,
        dlinear_ch_raw,
        patchtst_ch_raw,
    ) = await asyncio.gather(
        feat_task,
        chronos_task,
        dlinear_task,
        patchtst_task,
        state_space_task,
        dlinear_ch_task,
        patchtst_ch_task,
        return_exceptions=True,
    )

    # Guard against Chronos total failure (don't let it block feature preds)
    chronos_map: dict[str, dict] = {}
    chronos_errors: list[str] = []
    if isinstance(chronos_raw, BaseException):
        logger.warning(f"[Pipeline V2] Chronos batch failed entirely: {chronos_raw} — skipping Chronos layer")
        chronos_errors.append(f"{type(chronos_raw).__name__}: {chronos_raw}")
    elif isinstance(chronos_raw, dict) and not chronos_raw.get("error"):
        for cr in chronos_raw.get("results") or []:
            sym = cr.get("symbol")
            if sym and not cr.get("error"):
                chronos_map[sym] = cr
            elif sym:
                chronos_errors.append(f"{sym}: {cr.get('error', 'unknown_error')}")
        logger.info(
            f"[Pipeline V2] Chronos universal: {len(chronos_map)}/{len(chronos_series)} succeeded"
        )
    elif isinstance(chronos_raw, dict) and chronos_raw.get("results") == []:
        logger.debug(f"[Pipeline V2] Chronos skipped: {chronos_raw.get('error')}")
        chronos_errors.append(str(chronos_raw.get("error") or "empty_results"))
    else:
        logger.warning(f"[Pipeline V2] Chronos batch returned error: {chronos_raw}")
        chronos_errors.append(str(chronos_raw))
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

    # Stage 6.2: KalmanFilter + MarkovSwitching state-space overlays.
    # They share one Modal call to avoid duplicate cold-start/import paths.
    def _drain_state_space(raw, name: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        if isinstance(raw, BaseException):
            logger.warning(f"[Pipeline V2] {name} batch failed: {raw}")
            return out
        if isinstance(raw, dict) and not raw.get("error"):
            fallback_count = 0
            fallback_reasons: dict[str, int] = {}
            for r in raw.get("results") or []:
                sym = r.get("symbol")
                if sym and not r.get("error"):
                    out[sym] = r
                    reason = r.get("fallback_reason")
                    if r.get("degraded") or reason:
                        fallback_count += 1
                        if reason:
                            fallback_reasons[str(reason)] = fallback_reasons.get(str(reason), 0) + 1
            log_msg = f"[Pipeline V2] {name}: {len(out)}/{len(chronos_series)} succeeded fallback={fallback_count}"
            if fallback_count:
                logger.warning(f"{log_msg} reasons={fallback_reasons}")
            else:
                logger.info(log_msg)
        elif isinstance(raw, dict) and raw.get("results") == []:
            logger.debug(f"[Pipeline V2] {name} skipped: {raw.get('error')}")
        else:
            logger.warning(f"[Pipeline V2] {name} batch returned error: {raw}")
        return out
    state_space_overlays = {}
    if isinstance(state_space_raw, dict) and isinstance(state_space_raw.get("overlays"), dict):
        state_space_overlays = state_space_raw["overlays"]
        logger.info(f"[Pipeline V2] State-space overlays metrics: {state_space_raw.get('metrics')}")
    elif isinstance(state_space_raw, dict) and state_space_raw.get("shadow"):
        logger.info(f"[Pipeline V2] State-space overlays shadow mode: {state_space_raw.get('shadow')}")
    elif isinstance(state_space_raw, dict) and state_space_raw.get("results") == []:
        logger.debug(f"[Pipeline V2] State-space overlays skipped: {state_space_raw.get('error')}")
    elif isinstance(state_space_raw, BaseException):
        logger.warning(f"[Pipeline V2] State-space overlays failed entirely: {state_space_raw}")
    else:
        logger.warning(f"[Pipeline V2] State-space overlays returned invalid payload: {state_space_raw}")
    kalman_raw = state_space_overlays.get("KalmanFilter", {})
    markov_raw = state_space_overlays.get("MarkovSwitching", {})
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

    # ── A: ML_POOL ensemble merge (8 alpha models with lifecycle) ──
    # 2026-05-06: IC is lane-aware and empirical-Bayes shrunk before serving.
    # Short-sample negative IC no longer hard-zeros a model; confirmed negative
    # IC plus failed validation still fail-closed.
    model_status, ic_universe, degraded_dampening, ev2_cfg, used_pool, pool = await asyncio.to_thread(_load_pool_and_ic)
    if used_pool:
        for sym, r in pred_map.items():
            try:
                serving_ic = _build_serving_ic_bundle(pool, _prediction_market_segment(r), ev2_cfg)
                if not serving_ic["weights"] and ic_universe:
                    serving_ic = {
                        "scope": _prediction_market_segment(r) or "GLOBAL",
                        "weights": dict(ic_universe),
                        "diagnostics": {},
                    }
                _attach_ensemble_v2(
                    r,
                    model_status,
                    serving_ic,
                    degraded_dampening,
                    ev2_cfg,
                    adaptive_params=state.get("adaptive_params") or {},
                )
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
        top_k_enabled = bool(
            ev2_cfg.get("topKOverrideEnabled", False)
            and ev2_cfg.get("allowLegacyTopKOverride", False)
        )
        top_k_count = int(ev2_cfg.get("topKCount", 3))
        top_k_conf = float(ev2_cfg.get("topKConfidenceOverride", 0.72))
        if top_k_enabled and top_k_count > 0:
            ranked = sorted(
                ((sym, v) for sym, v in pred_map.items() if "ensemble_v2" in v and _prediction_eligible_for_topk(v)),
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

    dispersion = build_prediction_dispersion_report(pred_map)
    logger.info(
        "[Pipeline V2] Prediction dispersion: "
        f"symbols={dispersion.get('n_symbols')} models={dispersion.get('n_models_seen')} "
        f"active_avg={dispersion.get('avg_active_weight_count')} "
        f"rank_std={dispersion.get('avg_raw_rank_std')} "
        f"merge_compression={dispersion.get('avg_merge_compression')} "
        f"flags={dispersion.get('flags')}"
    )
    return {"predictions": pred_map, "prediction_dispersion": dispersion}


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


def _normalize_market_segment(segment: Any) -> str | None:
    value = str(segment or "").strip().upper()
    if value in {"TWSE", "TSE", "LISTED"}:
        return "LISTED"
    if value in {"TPEX", "OTC"}:
        return "OTC"
    if value in {"ESB", "EMERGING"}:
        return "EMERGING"
    return None


def _prediction_market_segment(pred: dict) -> str | None:
    meta = pred.get("stock_meta") if isinstance(pred.get("stock_meta"), dict) else {}
    return _normalize_market_segment(meta.get("market_segment") or meta.get("market"))


def _prediction_eligible_for_topk(pred: dict) -> bool:
    """Controller top-K is a production BUY override, so it must stay tradable-only."""
    meta = pred.get("stock_meta") if isinstance(pred.get("stock_meta"), dict) else {}
    segment = _prediction_market_segment(pred)
    lane = str(meta.get("recommendation_lane") or "").strip() or ("tradable" if segment in {"LISTED", "OTC"} else "")
    if segment == "EMERGING":
        return False
    if lane and lane != "tradable":
        return False
    if meta.get("eligible_for_pending_buy") is False or meta.get("eligible_for_execution") is False:
        return False
    return True


def _coerce_ic_value(value: Any) -> float | None:
    if isinstance(value, dict):
        for key in ("ic", "rolling_ic", "ic_4w_avg", "value"):
            if key in value:
                return _coerce_ic_value(value.get(key))
        return None
    try:
        if value is not None:
            return float(value)
    except (TypeError, ValueError):
        return None
    return None


def _entry_serving_ic(entry: dict, market_segment: str | None = None) -> tuple[float | None, str]:
    """Choose lane IC first; fall back to global lifecycle IC only when absent."""
    segment = _normalize_market_segment(market_segment)
    segment_map = entry.get("last_ic_by_segment")
    if segment and isinstance(segment_map, dict):
        segment_ic = _coerce_ic_value(segment_map.get(segment))
        if segment_ic is not None:
            return segment_ic, f"last_ic_by_segment.{segment}"

    for key in ("ic_4w_avg", "weekly_ic", "rolling_ic"):
        value = entry.get(key)
        if key == "weekly_ic":
            history = value or []
            value = history[-1] if history else None
        ic_value = _coerce_ic_value(value)
        if ic_value is not None:
            return ic_value, key
    return None, "missing"


def _coerce_sample_count(value: Any) -> int | None:
    try:
        if value is not None:
            return max(0, int(float(value)))
    except (TypeError, ValueError):
        return None
    return None


def _entry_ic_sample_count(entry: dict, source: str) -> int:
    if source.startswith("last_ic_by_segment."):
        segment = source.split(".", 1)[1]
        segment_map = entry.get("last_ic_by_segment")
        segment_value = segment_map.get(segment) if isinstance(segment_map, dict) else None
        if isinstance(segment_value, dict):
            for key in ("n_samples", "sample_count", "samples", "coverage"):
                count = _coerce_sample_count(segment_value.get(key))
                if count is not None:
                    return count
    for key in ("last_ic_sample_count", "active_ic_samples", "ic_sample_count", "sample_count", "coverage_samples"):
        count = _coerce_sample_count(entry.get(key))
        if count is not None:
            return count
    history = entry.get("weekly_ic") or []
    if source == "weekly_ic" and isinstance(history, list):
        return len(history)
    return 0


def _ic_weighting_policy(ev2_cfg: dict | None = None) -> dict[str, Any]:
    raw = ((ev2_cfg or {}).get("icWeighting") or {}) if isinstance(ev2_cfg, dict) else {}
    return {
        "method": str(raw.get("method") or "empirical_bayes_shrinkage"),
        "enabled": bool(raw.get("enabled", True)),
        "prior_ic": float(raw.get("priorIc", raw.get("priorIC", 0.015)) or 0.015),
        "prior_strength": float(raw.get("priorStrength", 20.0) or 20.0),
        "min_samples_for_hard_zero": int(raw.get("minSamplesForHardZero", 40) or 40),
        "uncertain_negative_floor": float(raw.get("uncertainNegativeFloor", raw.get("pooledSegmentFloor", 0.0025)) or 0.0025),
        "pooled_segment_fallback_enabled": bool(raw.get("pooledSegmentFallbackEnabled", True)),
        "pooled_segment_floor": float(raw.get("pooledSegmentFloor", 0.0025) or 0.0025),
        "pooled_segment_fallback_multiplier": float(raw.get("pooledSegmentFallbackMultiplier", 0.25) or 0.25),
        "pooled_segment_cap": float(raw.get("pooledSegmentCap", 0.015) or 0.015),
    }


def _shrink_ic_weight(
    ic_value: float | None,
    sample_count: int,
    validation_multiplier: float,
    ev2_cfg: dict | None = None,
) -> tuple[float | None, dict[str, Any]]:
    policy = _ic_weighting_policy(ev2_cfg)
    if ic_value is None:
        return None, {"policy": policy["method"], "reason": "ic_missing"}
    raw_ic = float(ic_value)
    if not policy["enabled"]:
        effective = raw_ic * validation_multiplier
        return effective, {
            "policy": "raw_ic",
            "raw_ic": raw_ic,
            "sample_count": sample_count,
            "posterior_ic": raw_ic,
            "effective_weight": effective,
        }

    prior_strength = max(0.0, float(policy["prior_strength"]))
    n = max(0, int(sample_count or 0))
    alpha = n / (n + prior_strength) if (n + prior_strength) > 0 else 1.0
    posterior = (alpha * raw_ic) + ((1.0 - alpha) * float(policy["prior_ic"]))
    if n >= int(policy["min_samples_for_hard_zero"]) and raw_ic < 0 and posterior <= 0:
        effective = 0.0
        reason = "negative_ic_confirmed"
    elif raw_ic < 0 and posterior <= 0:
        # Low-sample segment IC is noisy; keep a tiny exploration floor instead of
        # freezing the model out before pooled/global evidence can recover it.
        effective = max(0.0, float(policy["uncertain_negative_floor"]))
        reason = "uncertain_negative_floor"
    else:
        effective = max(0.0, posterior)
        reason = "shrunk_to_prior"
    effective *= max(0.0, float(validation_multiplier or 0.0))
    return effective, {
        "policy": policy["method"],
        "raw_ic": raw_ic,
        "prior_ic": float(policy["prior_ic"]),
        "prior_strength": prior_strength,
        "sample_count": n,
        "shrink_alpha": round(alpha, 6),
        "posterior_ic": round(posterior, 8),
        "effective_weight": round(effective, 8),
        "reason": reason,
    }


def _validation_multiplier(entry: dict) -> tuple[float, str, str]:
    evidence = (
        entry.get("model_cpcv")
        or entry.get("validation_packet")
        or entry.get("promotion_gate")
        or entry.get("validation")
        or {}
    )
    if not isinstance(evidence, dict) or not evidence:
        return 1.0, "MISSING", "no_model_validation_evidence"
    decision = str(
        evidence.get("decision")
        or evidence.get("go_live_verdict")
        or evidence.get("status")
        or ""
    ).strip().upper()
    try:
        pbo_fail = evidence.get("pbo") is not None and float(evidence.get("pbo")) >= 0.50
    except (TypeError, ValueError):
        pbo_fail = False
    if decision == "FAIL" or pbo_fail:
        return 0.0, "FAIL", "cpcv_pbo_failed"
    if decision in {"WARN", "WARNING"}:
        return 0.5, "WARN", "validation_warning"
    if decision == "PASS":
        return 1.0, "PASS", "validation_pass"
    return 1.0, "UNKNOWN", "validation_evidence_unrecognized"


def _build_serving_ic_bundle(
    pool: dict | None,
    market_segment: str | None = None,
    ev2_cfg: dict | None = None,
) -> dict:
    scope = _normalize_market_segment(market_segment) or "GLOBAL"
    weights: dict[str, float] = {}
    diagnostics: dict[str, dict] = {}
    for name, entry in ((pool or {}).get("models") or {}).items():
        ic_value, source = _entry_serving_ic(entry, None if scope == "GLOBAL" else scope)
        multiplier, validation_status, validation_reason = _validation_multiplier(entry)
        sample_count = _entry_ic_sample_count(entry, source)
        effective_weight, shrinkage = _shrink_ic_weight(ic_value, sample_count, multiplier, ev2_cfg)
        policy = _ic_weighting_policy(ev2_cfg)
        if (
            scope != "GLOBAL"
            and policy.get("pooled_segment_fallback_enabled")
            and float(effective_weight or 0.0) == 0.0
            and shrinkage.get("reason") == "negative_ic_confirmed"
            and multiplier > 0
        ):
            pooled_ic, pooled_source = _entry_serving_ic(entry, None)
            pooled_sample_count = _entry_ic_sample_count(entry, pooled_source)
            pooled_weight, pooled_shrinkage = _shrink_ic_weight(
                pooled_ic,
                pooled_sample_count,
                multiplier,
                ev2_cfg,
            )
            if pooled_weight is not None and pooled_weight > 0:
                fallback_weight = min(
                    float(policy["pooled_segment_cap"]),
                    max(
                        float(policy["pooled_segment_floor"]),
                        float(pooled_weight) * float(policy["pooled_segment_fallback_multiplier"]),
                    ),
                )
                effective_weight = fallback_weight
                shrinkage = {
                    **shrinkage,
                    "reason": "pooled_segment_floor",
                    "segment_reason": "negative_ic_confirmed",
                    "pooled_ic": pooled_ic,
                    "pooled_ic_source": pooled_source,
                    "pooled_ic_sample_count": pooled_sample_count,
                    "pooled_effective_weight": round(float(pooled_weight), 8),
                    "pooled_floor_weight": round(float(fallback_weight), 8),
                    "pooled_shrinkage_reason": pooled_shrinkage.get("reason"),
                }
        if effective_weight is not None:
            weights[name] = float(effective_weight)
        diagnostics[name] = {
            "scope": scope,
            "ic_value": ic_value,
            "ic_source": source,
            "ic_sample_count": sample_count,
            "ic_shrinkage": shrinkage,
            "validation_multiplier": multiplier,
            "validation_status": validation_status,
            "validation_reason": validation_reason,
            "last_ic_status": entry.get("last_ic_status"),
            "last_ic_root_cause": entry.get("last_ic_root_cause"),
            "last_ic_sample_count": entry.get("last_ic_sample_count"),
        }
    return {"scope": scope, "weights": weights, "diagnostics": diagnostics}


def _adaptive_threshold_delta(adaptive_params: dict | None = None) -> tuple[float, dict[str, Any]]:
    params = adaptive_params or {}
    components = params.get("threshold_components") if isinstance(params.get("threshold_components"), dict) else None
    if components and components.get("effective_delta") is not None:
        try:
            delta = float(components.get("effective_delta") or 0.0)
        except (TypeError, ValueError):
            delta = 0.0
        return delta, {
            "source": "threshold_components.effective_delta",
            "effective_delta": round(delta, 4),
            "components": components,
            "provenance": params.get("provenance") if isinstance(params.get("provenance"), dict) else {},
        }

    try:
        delta = float(params.get("confidence_delta") or 0.0)
    except (TypeError, ValueError):
        delta = 0.0
    return delta, {
        "source": "confidence_delta_legacy",
        "effective_delta": round(delta, 4),
        "components": None,
        "provenance": params.get("provenance") if isinstance(params.get("provenance"), dict) else {},
    }


def _resolve_alpha_regime_label(
    raw_regime: Any,
    regime_meta: dict | None,
    adaptive_params: dict | None,
) -> str:
    """Resolve alpha-framework regime from the canonical pre-pipeline contract."""
    candidates: list[Any] = [raw_regime]
    if isinstance(regime_meta, dict):
        candidates.extend([
            regime_meta.get("regime"),
            regime_meta.get("current_regime"),
            regime_meta.get("dominant_regime"),
        ])
    if isinstance(adaptive_params, dict):
        provenance = adaptive_params.get("provenance")
        components = adaptive_params.get("threshold_components")
        inputs = components.get("inputs") if isinstance(components, dict) else None
        if isinstance(provenance, dict):
            candidates.append(provenance.get("regime"))
        if isinstance(inputs, dict):
            candidates.append(inputs.get("regime"))

    for candidate in candidates:
        value = str(candidate or "").strip().lower()
        if value and value not in {"unknown", "none", "null", "n/a"}:
            return value
    return "unknown"


def _rank_signal_thresholds(ev2_cfg: dict | None, adaptive_params: dict | None = None) -> dict[str, float]:
    cfg = ev2_cfg or {}
    delta, _meta = _adaptive_threshold_delta(adaptive_params)

    def clipped(value: float) -> float:
        return max(0.01, min(0.99, value))

    return {
        "strongBuyThreshold": clipped(float(cfg.get("strongBuyThreshold", 0.85)) + delta),
        "buyThreshold": clipped(float(cfg.get("buyThreshold", 0.70)) + delta),
        "sellThreshold": clipped(float(cfg.get("sellThreshold", 0.30)) - delta),
        "strongSellThreshold": clipped(float(cfg.get("strongSellThreshold", 0.15)) - delta),
    }


def _load_pool_and_ic():
    """Synchronous loader (called via asyncio.to_thread).

    Returns:
      (model_status, ic_weights, degraded_dampening, ev2_cfg, used_pool, pool)

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
            return {}, {}, 1.0, {}, False, {}
        bucket = storage.Client().bucket(bucket_name)
        pool_blob = bucket.blob("universal/model_pool.json")
        if not pool_blob.exists():
            return {}, {}, 1.0, {}, False, {}
        pool = _json.loads(pool_blob.download_as_text())
        model_status: dict[str, str] = {}
        ic_weights: dict[str, float] = {}
        for name, entry in pool.get("models", {}).items():
            model_status[name] = entry.get("status", "active")
            last_status = str(entry.get("last_ic_status") or "").strip()
            last_root_cause = str(entry.get("last_ic_root_cause") or "").strip()
            has_fresh_diagnostics = bool(last_status or last_root_cause)
            if has_fresh_diagnostics and not (last_status == "computed" and last_root_cause in ("", "ok")):
                continue
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

        # IC weights have exactly one owner: model_pool.json. Missing IC stays
        # missing so lifecycle diagnostics can explain the root cause.
        # KV-driven degraded dampening + ensemble_v2 thresholds / Top-K cfg
        degraded_dampening = 1.0
        ev2_cfg: dict = {}
        try:
            from services.trading_config_loader import load_merged_trading_config_with_contract
            cfg_result = load_merged_trading_config_with_contract()
            tcfg = cfg_result.config
            if cfg_result.contract.degraded:
                logger.warning("[Pipeline V2] trading:config degraded: %s", cfg_result.contract.to_dict())
            ml_pool_cfg = tcfg.get("mlPool", {}) or {}
            degraded_dampening = float(ml_pool_cfg.get("degradedDampening", 1.0))
            ev2_cfg = dict(tcfg.get("ensemble_v2", {}) or {})
            if not ev2_cfg.get("expectedReturnCalibration"):
                calibration = _load_expected_return_calibration()
                if calibration:
                    ev2_cfg["expectedReturnCalibration"] = calibration
        except Exception as _e:
            logger.debug(f"[Pipeline V2] trading:config merged lookup failed (using defaults): {_e}")
        return model_status, ic_weights, degraded_dampening, ev2_cfg, True, pool
    except Exception as e:
        logger.warning(f"[Pipeline V2] _load_pool_and_ic failed: {e}")
        return {}, {}, 1.0, {}, False, {}


def _load_expected_return_calibration(
    *,
    lookback_days: int = 90,
    min_samples: int = 30,
    min_bin_samples: int = 8,
    max_bins: int = 8,
) -> dict[str, Any] | None:
    """Build empirical avg_rank -> realized return bins from verified outcomes.

    This deliberately fails closed when verified coverage is insufficient: a
    rank score is not an expected return until production outcomes calibrate it.
    """
    try:
        rows = d1_client.query(
            """
            SELECT forecast_data, actual_return_pct
              FROM predictions
             WHERE model_name = 'ensemble'
               AND verified_at IS NOT NULL
               AND actual_return_pct IS NOT NULL
               AND forecast_data IS NOT NULL
               AND date(prediction_date) >= date('now', ?)
             ORDER BY prediction_date DESC
             LIMIT 2000
            """,
            [f"-{max(1, int(lookback_days))} days"],
        )
    except Exception as exc:
        logger.debug(f"[Pipeline V2] expected-return calibration query skipped: {exc}")
        return None

    samples: list[tuple[float, float]] = []
    for row in rows or []:
        try:
            payload = json.loads(row.get("forecast_data") or "{}")
            avg_rank = payload.get("ensemble_v2", {}).get("avg_rank")
            actual = row.get("actual_return_pct")
            if avg_rank is None or actual is None:
                continue
            avg_rank_f = float(avg_rank)
            actual_f = float(actual)
            if not (0.0 <= avg_rank_f <= 1.0):
                continue
            if not (-1.0 < actual_f < 1.0):
                continue
            samples.append((avg_rank_f, actual_f))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue

    if len(samples) < min_samples:
        return None

    samples.sort(key=lambda item: item[0])
    bin_count = max(1, min(max_bins, len(samples) // max(1, min_bin_samples)))
    bins: list[dict[str, Any]] = []
    for idx in range(bin_count):
        start = round(idx * len(samples) / bin_count)
        end = round((idx + 1) * len(samples) / bin_count)
        subset = samples[start:end]
        if len(subset) < min_bin_samples:
            continue
        returns = sorted(actual for _, actual in subset)
        mean_return = sum(returns) / len(returns)
        median_return = returns[len(returns) // 2]
        bins.append({
            "rankLow": round(subset[0][0], 6),
            "rankHigh": round(subset[-1][0], 6),
            "meanReturn": round(mean_return, 6),
            "medianReturn": round(median_return, 6),
            "samples": len(subset),
        })

    if not bins:
        return None
    bins = _monotonic_smooth_return_bins(bins)
    return {
        "source": "verified_ensemble_outcomes",
        "method": "empirical_rank_bins_monotonic",
        "lookbackDays": int(lookback_days),
        "minSamples": int(min_bin_samples),
        "sampleCount": len(samples),
        "bins": bins,
    }


def _monotonic_smooth_return_bins(bins: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pool adjacent return bins so higher rank never maps to lower return."""
    blocks: list[dict[str, Any]] = []
    for idx, row in enumerate(bins):
        samples = max(1, int(row.get("samples") or 1))
        mean_return = float(row.get("meanReturn") or 0.0)
        blocks.append({
            "weight": samples,
            "sum": mean_return * samples,
            "items": [idx],
        })
        while len(blocks) >= 2:
            left = blocks[-2]
            right = blocks[-1]
            left_mean = left["sum"] / left["weight"]
            right_mean = right["sum"] / right["weight"]
            if left_mean <= right_mean:
                break
            merged = {
                "weight": left["weight"] + right["weight"],
                "sum": left["sum"] + right["sum"],
                "items": left["items"] + right["items"],
            }
            blocks[-2:] = [merged]

    smoothed = [dict(row) for row in bins]
    for block in blocks:
        block_mean = block["sum"] / block["weight"]
        for idx in block["items"]:
            smoothed[idx]["rawMeanReturn"] = smoothed[idx].get("meanReturn")
            smoothed[idx]["meanReturn"] = round(block_mean, 6)
            smoothed[idx]["calibration"] = "pava_monotonic"
    return smoothed


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
    *,
    adaptive_params: dict | None = None,
) -> None:
    bundle = ic_weights if isinstance(ic_weights, dict) and "weights" in ic_weights else None
    serving_weights = bundle.get("weights", {}) if bundle else ic_weights
    thresholds = _rank_signal_thresholds(ev2_cfg, adaptive_params)
    adaptive_threshold_delta, adaptive_threshold_meta = _adaptive_threshold_delta(adaptive_params)
    effective_cfg = {**(ev2_cfg or {}), **thresholds}
    if bundle:
        effective_cfg["observedIcModels"] = [
            name for name, diag in (bundle.get("diagnostics") or {}).items()
            if isinstance(diag, dict) and diag.get("ic_value") is not None
        ]
    attach_ensemble_v2(pred, model_status, serving_weights, degraded_dampening, effective_cfg)
    ev2 = pred.get("ensemble_v2")
    if isinstance(ev2, dict):
        ev2["ic_weight_scope"] = (bundle or {}).get("scope") or _prediction_market_segment(pred) or "GLOBAL"
        ev2["rank_signal_thresholds"] = {k: round(float(v), 4) for k, v in thresholds.items()}
        ev2["adaptive_threshold"] = {
            **adaptive_threshold_meta,
            "applied_delta": round(float(adaptive_threshold_delta), 4),
        }
        if bundle:
            ev2["ic_weight_diagnostics"] = bundle.get("diagnostics") or {}

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
            f"SELECT symbol, tag FROM stock_tags WHERE tag_type = 'concept' AND symbol IN ({placeholders}) "
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
    and upsert into sector_flow. Screener consumes the latest completed sector_flow
    before this pipeline starts, so this refresh is post-write evidence for
    dashboards and the next screener run. It must not contend with the hot-path
    market_env reads.

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
    Filter SELL, compute canonical Score V2 finalScore, and apply hybrid ranking promotion.
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
    regime_contract = resolve_market_regime_contract(kv_client)
    regime_label = str(regime_contract.get("alpha_regime") or "unknown")
    regime_surface = regime_contract.get("regime_surface") if isinstance(regime_contract.get("regime_surface"), dict) else {}
    if regime_contract.get("missing") or regime_label == "unknown":
        raise RuntimeError(
            "ml:regime missing before recommendation; market_regime_state missing before recommendation; "
            "run regime-compute before pipeline"
        )

    from services.trading_config_loader import load_merged_trading_config_with_contract
    cfg_result = load_merged_trading_config_with_contract()
    trading_cfg = cfg_result.config
    if cfg_result.contract.degraded:
        logger.warning("[Pipeline V2] trading:config degraded in recommend: %s", cfg_result.contract.to_dict())
    alpha_policy = trading_cfg.get("alphaFramework", {}) or trading_cfg.get("alpha_framework", {}) or {}
    screener_recs = state["screener_recs"]
    if not screener_recs:
        raise RuntimeError(
            "screener_recs_missing: daily pipeline requires full-market screener "
            "seeds before ML/recommendation; refusing watchlist fallback"
        )

    fundamental_quality_by_symbol = load_fundamental_quality_by_symbol(screener_recs, state["run_date"])

    final, sell_count = filter_and_score_recommendations(
        screener_recs,
        state["predictions"],
        state["payloads"],
        persona_opinions=state.get("persona_opinions") or {},
        persona_weight=persona_weight,
        regime_label=regime_label,
        regime_surface=regime_surface,
        alpha_policy=alpha_policy,
        fundamental_quality_by_symbol=fundamental_quality_by_symbol,
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
        breeze2_shadow = {}
        if _breeze2_reason_shadow_enabled():
            provider = _breeze2_reason_shadow_provider()
            try:
                breeze2_shadow = (
                    await build_breeze2_generation_shadow_for_candidates(candidates, run_date=state.get("run_date"))
                    if provider == "modal_generation"
                    else build_breeze2_reason_shadow_for_candidates(candidates)
                )
            except Exception as shadow_error:  # noqa: BLE001 - shadow provider must not block D1 writes.
                logger.warning("[Pipeline V2] Breeze2 reason shadow skipped: %s", shadow_error)
        if breeze2_shadow:
            logger.info("[Pipeline V2] Breeze2 reason shadow generated: %s", breeze2_reason_shadow_metrics(breeze2_shadow))
        return {"llm_reasons": reasons, "breeze2_reason_shadow": breeze2_shadow}
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
    stale_predictions_deleted = prune_predictions_outside_universe(list(stock_id_map.values()), run_date)
    predictions_written = write_predictions_to_d1(state["predictions"], stock_id_map, run_date)

    # 2. Merge LLM reasons into recommendations (overwrite template)
    final = state["final_recommendations"]
    merge_llm_reasons_into_recommendations(final, state.get("llm_reasons") or {})
    merge_breeze2_reason_shadow_into_score_components(final, state.get("breeze2_reason_shadow") or {})

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
        "prediction_symbols": len(stock_id_map),
        "prediction_output_models": round(predictions_written / len(stock_id_map)) if stock_id_map else 0,
        "stale_predictions_deleted": stale_predictions_deleted,
        "recommendations_updated": rec_updated,
        "sell_deleted": sell_deleted,
        "llm_reasons_count": len(state.get("llm_reasons") or {}),
        "breeze2_reason_shadow": breeze2_reason_shadow_metrics(state.get("breeze2_reason_shadow") or {}),
        "alpha_bucket_counts": alpha_bucket_counts,
        "alpha_selected_bucket_counts": alpha_selected_bucket_counts,
        "alpha_skip_count": alpha_skip_count,
    }
    dispersion = state.get("prediction_dispersion") or {}
    if dispersion:
        metrics["prediction_dispersion"] = {
            key: value for key, value in dispersion.items()
            if key != "symbols"
        }
    logger.info(f"[Pipeline V2] write_d1 done: {metrics}")
    return {"metrics": metrics}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _snapshot_export_start_date(run_date: str) -> str:
    """Resolve the rolling research snapshot window from the pipeline run date."""
    try:
        lookback_days = int(os.getenv("STOCKVISION_RESEARCH_SNAPSHOT_LOOKBACK_DAYS", "504") or "504")
    except ValueError:
        lookback_days = 504
    lookback_days = max(30, min(lookback_days, 1600))
    return (datetime.strptime(run_date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")


async def node_export_dataset_snapshot(state: PipelineStateV2) -> dict:
    """Export the post-recommendation research snapshot after serving D1 is written."""
    logger.info("[Pipeline V2] node_export_dataset_snapshot")
    metrics = dict(state.get("metrics") or {})
    run_date = state["run_date"]
    producer_run_id = state.get("producer_run_id") or f"pipeline-v2:{run_date}"

    if os.getenv("STOCKVISION_EXPORT_RESEARCH_SNAPSHOT", "1").strip().lower() in {"0", "false", "no", "off"}:
        metrics["dataset_snapshot_export"] = {
            "status": "skipped",
            "reason": "STOCKVISION_EXPORT_RESEARCH_SNAPSHOT disabled",
        }
        return {"metrics": metrics}

    mode = os.getenv("STOCKVISION_RESEARCH_SNAPSHOT_MODE", "deferred").strip().lower()
    if mode not in {"blocking", "sync", "synchronous"}:
        metrics["dataset_snapshot_export"] = {
            "status": "deferred",
            "mode": mode or "deferred",
            "reason": "daily serving pipeline must not block on research/backtest snapshot export",
            "producer_run_id": producer_run_id,
        }
        return {"metrics": metrics}

    try:
        from services.dataset_snapshot_exporter import (
            DatasetSnapshotExportRequest,
            export_daily_research_snapshots,
        )

        request = DatasetSnapshotExportRequest(
            business_date=run_date,
            start_date=_snapshot_export_start_date(run_date),
            end_date=run_date,
            producer_run_id=producer_run_id,
            include_signals=True,
        )
        combined = await asyncio.to_thread(export_daily_research_snapshots, request)
        backtest_summary = (combined.get("snapshots") or {}).get("backtest_dataset") or {}
        price_summary = (combined.get("snapshots") or {}).get("price_history") or {}
        backtest_snapshot = backtest_summary.get("snapshot") or {}
        price_snapshot = price_summary.get("snapshot") or {}
        metrics["dataset_snapshot_export"] = {
            "status": "ready",
            "snapshots": {
                "backtest_dataset": {
                    "snapshot_id": backtest_snapshot.get("snapshot_id"),
                    "row_count": backtest_snapshot.get("row_count"),
                    "elapsed_s": backtest_summary.get("elapsed_s"),
                    "d1_query_counts": backtest_summary.get("d1_query_counts"),
                },
                "price_history": {
                    "snapshot_id": price_snapshot.get("snapshot_id"),
                    "row_count": price_snapshot.get("row_count"),
                    "elapsed_s": price_summary.get("elapsed_s"),
                    "d1_query_counts": price_summary.get("d1_query_counts"),
                },
            },
        }
        logger.info(
            "[Pipeline V2] dataset snapshots exported: backtest=%s price_history=%s",
            backtest_snapshot.get("snapshot_id"),
            price_snapshot.get("snapshot_id"),
        )
        return {"metrics": metrics}
    except Exception as e:  # noqa: BLE001
        metrics["dataset_snapshot_export"] = {
            "status": "error",
            "error": f"{type(e).__name__}: {e}",
        }
        logger.exception("[Pipeline V2] dataset snapshot export failed")
        return {
            "metrics": metrics,
            "errors": [f"dataset_snapshot_export: {type(e).__name__}: {e}"],
        }


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
    g.add_node("export_dataset_snapshot", node_export_dataset_snapshot)

    # Keep D1-heavy sector_flow out of the hot-path fan-out. The 22:00 chain
    # already runs indicator + screener writes, and parallel D1 readers can trip
    # Cloudflare D1 queued-too-long 429s.
    g.set_entry_point("load_inputs")
    g.add_edge("load_inputs",         "load_market_env")
    g.add_edge("load_market_env",     "build_payloads")
    g.add_edge("build_payloads",      "ml_predict")
    g.add_edge("ml_predict",          "compute_personas")
    g.add_edge("compute_personas",    "recommend")
    g.add_edge("recommend",           "gen_llm_reasons")
    g.add_edge("gen_llm_reasons",     "write_d1")
    g.add_edge("write_d1",            "compute_sector_flow")
    g.add_edge("compute_sector_flow", "export_dataset_snapshot")
    g.add_edge("export_dataset_snapshot", END)

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

async def run_pipeline_v2(run_date: str = "", producer_run_id: str = "") -> dict:
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
        "producer_run_id": producer_run_id or f"pipeline-v2:{run_date}",
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
