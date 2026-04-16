"""
daily_pipeline_v2.py — Real LangGraph StateGraph for daily prediction pipeline
2026-04-07 LangGraph A+B refactor

Replaces graphs/daily_pipeline.py which was a "fake LangGraph" — fire-and-forget
HTTP shell where state held only step_status, not domain data.

Real LangGraph this time:
  - State is typed schema with full domain data (active_stocks, payloads, predictions, etc.)
  - Nodes are pure functions reading & writing state
  - All D1/ML calls done by ml-controller directly (no fire-and-forget to worker)
  - SqliteSaver checkpointer for resume support
  - Linear edges screener_load → market_env → payloads → ml_predict → recommend → llm_reasons → write_d1
"""
from __future__ import annotations
import asyncio
import logging
import operator
from datetime import datetime, timezone
from typing import Annotated, Any, TypedDict

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.pregel.types import RetryPolicy

from services import d1_client, kv_client
from services.payload_builder import (
    PredictPayload,
    load_active_stocks,
    load_market_env,
    build_payloads,
)
from services.modal_client import batch_predict
from services.recommendation_service import (
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
    lifecycle_weights: dict                 # from D1 model_lifecycle_state
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

    active_stocks = load_active_stocks()
    screener_recs = d1_client.query(
        "SELECT * FROM daily_recommendations WHERE date = ? ORDER BY rank",
        [run_date],
    )

    logger.info(
        f"[Pipeline V2] Loaded {len(active_stocks)} active stocks, "
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
    """
    payloads = state["payloads"]
    n = len(payloads)
    logger.info(f"[Pipeline V2] node_ml_predict: {n} stocks (single batch, parallel)")

    if not payloads:
        return {"predictions": {}}

    results = await batch_predict(payloads)
    pred_map: dict[str, dict] = {}
    for r in results:
        sym = r.get("symbol")
        if sym and not r.get("error"):
            pred_map[sym] = r

    error_count = sum(1 for r in results if r.get("error"))
    logger.info(
        f"[Pipeline V2] ML predict done: {len(pred_map)}/{n} succeeded, "
        f"{error_count} errors"
    )
    return {"predictions": pred_map}


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

    final, sell_count = filter_and_score_recommendations(
        state["screener_recs"],
        state["predictions"],
        state["payloads"],
        persona_opinions=state.get("persona_opinions") or {},
        persona_weight=persona_weight,
    )

    # Hybrid ranking from KV trading:config.ranking
    trading_cfg = kv_client.get_json("trading:config", default={}) or {}
    ranking_cfg = trading_cfg.get("ranking", {"enabled": True, "topK": 3,
                                              "alpha": 0.40, "beta": 0.40, "gamma": 0.20,
                                              "screenerDenominator": 60.0, "promoteMinConf": 0.60})
    final = hybrid_ranking_promotion(final, ranking_cfg)

    # Track which symbols were filtered out (for D1 delete in write_d1)
    final_syms = {r["symbol"] for r in final}
    filtered_syms = [r["symbol"] for r in state["screener_recs"] if r["symbol"] not in final_syms]

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
    predictions_written = write_predictions_to_d1(state["predictions"], stock_id_map)

    # 2. Merge LLM reasons into recommendations (overwrite template)
    final = state["final_recommendations"]
    merge_llm_reasons_into_recommendations(final, state.get("llm_reasons") or {})

    # 3. Update daily_recommendations
    rec_updated = update_recommendations_in_d1(final, run_date)

    # 4. Delete SELL-filtered rows
    sell_deleted = delete_filtered_recommendations(state.get("sell_filtered_symbols") or [], run_date)

    # 5. Re-rank
    re_rank_recommendations(run_date)

    metrics = {
        "predictions_written": predictions_written,
        "recommendations_updated": rec_updated,
        "sell_deleted": sell_deleted,
        "llm_reasons_count": len(state.get("llm_reasons") or {}),
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

    g.set_entry_point("load_inputs")
    g.add_edge("load_inputs",         "load_market_env")
    g.add_edge("load_market_env",     "compute_sector_flow")
    g.add_edge("compute_sector_flow", "build_payloads")
    g.add_edge("build_payloads",      "ml_predict")
    g.add_edge("ml_predict",          "compute_personas")
    g.add_edge("compute_personas",    "recommend")
    g.add_edge("recommend",           "gen_llm_reasons")
    g.add_edge("gen_llm_reasons",     "write_d1")
    g.add_edge("write_d1",            END)

    # Checkpointer disabled for now:
    # - SqliteSaver doesn't support async (raises NotImplementedError on ainvoke)
    # - AsyncSqliteSaver requires aiosqlite + extra setup
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
