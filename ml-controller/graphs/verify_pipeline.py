from __future__ import annotations

import asyncio
import logging
import operator
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, StateGraph

from services import verify_service
from services.modal_client import batch_update_arf

logger = logging.getLogger(__name__)


class VerifyStateV2(TypedDict, total=False):
    run_date: str
    lookback_days: int
    limit: int
    pending_predictions: list[dict]
    market_risk: dict
    verify_updates: list[dict]
    arf_feedback_items: list[dict]
    pending: int
    verified: int
    correct: int
    total_pnl_pct: float
    model_accuracy_groups: int
    trade_performance_groups: int
    arf_updated: int
    metrics: dict
    errors: Annotated[list[str], operator.add]
    update_aggregates: bool


async def node_load_pending(state: VerifyStateV2) -> dict:
    logger.info("[Verify V2] node_load_pending")
    lookback_days = int(state.get("lookback_days") or 5)
    limit = int(state.get("limit") or 200)
    pending = await asyncio.to_thread(
        verify_service.load_pending_predictions,
        lookback_days,
        limit,
        state.get("run_date") or "",
    )
    market_risk = await asyncio.to_thread(verify_service.load_market_risk)
    return {
        "pending_predictions": pending,
        "market_risk": market_risk,
        "pending": len(pending),
    }


async def node_simulate_predictions(state: VerifyStateV2) -> dict:
    logger.info("[Verify V2] node_simulate_predictions")
    pending = state.get("pending_predictions") or []
    if not pending:
        return {
            "verify_updates": [],
            "arf_feedback_items": [],
            "verified": 0,
            "correct": 0,
            "total_pnl_pct": 0.0,
        }

    prepared = await asyncio.to_thread(
        verify_service.prepare_verification_updates,
        pending,
        state.get("market_risk") or {},
    )
    summary = verify_service.summarize_verification_updates(
        len(pending),
        prepared.get("verify_updates") or [],
    )
    return {
        "verify_updates": prepared.get("verify_updates") or [],
        "arf_feedback_items": prepared.get("arf_feedback_items") or [],
        "errors": prepared.get("errors") or [],
        **summary,
    }


async def node_write_verified(state: VerifyStateV2) -> dict:
    logger.info("[Verify V2] node_write_verified")
    updates = state.get("verify_updates") or []
    written = await asyncio.to_thread(verify_service.write_verified_predictions, updates)
    return {"metrics": {**(state.get("metrics") or {}), "verified_rows_written": written}}


async def node_update_model_accuracy(state: VerifyStateV2) -> dict:
    logger.info("[Verify V2] node_update_model_accuracy")
    if not state.get("update_aggregates", False):
        logger.info("[Verify V2] model_accuracy aggregate refresh skipped for nightly path")
        return {"model_accuracy_groups": 0}
    count = await asyncio.to_thread(verify_service.update_model_accuracy)
    return {"model_accuracy_groups": count}


async def node_update_trade_performance(state: VerifyStateV2) -> dict:
    logger.info("[Verify V2] node_update_trade_performance")
    if not state.get("update_aggregates", False):
        logger.info("[Verify V2] trade_performance aggregate refresh skipped for nightly path")
        return {"trade_performance_groups": 0}
    count = await asyncio.to_thread(verify_service.update_trade_performance)
    return {"trade_performance_groups": count}


async def node_arf_feedback(state: VerifyStateV2) -> dict:
    logger.info("[Verify V2] node_arf_feedback")
    items = state.get("arf_feedback_items") or []
    if not items:
        return {"arf_updated": 0}

    try:
        results = await batch_update_arf(items)
        updated = sum(
            1 for r in results
            if isinstance(r, dict) and (r.get("status") == "ok" or r.get("updated"))
        )
        logger.info("[Verify V2] ARF feedback: %s/%s updated", updated, len(items))
        return {"arf_updated": updated}
    except Exception as e:
        logger.warning("[Verify V2] ARF feedback failed (non-blocking): %s", e)
        return {"errors": [f"arf_feedback non-fatal: {e}"], "arf_updated": 0}


_verify_graph_singleton: Any = None


def build_verify_graph():
    g = StateGraph(VerifyStateV2)
    g.add_node("load_pending", node_load_pending)
    g.add_node("simulate_predictions", node_simulate_predictions)
    g.add_node("write_verified", node_write_verified)
    g.add_node("update_model_accuracy", node_update_model_accuracy)
    g.add_node("update_trade_performance", node_update_trade_performance)
    g.add_node("arf_feedback", node_arf_feedback)

    g.set_entry_point("load_pending")
    g.add_edge("load_pending", "simulate_predictions")
    g.add_edge("simulate_predictions", "write_verified")
    g.add_edge("write_verified", "update_model_accuracy")
    g.add_edge("update_model_accuracy", "update_trade_performance")
    g.add_edge("update_trade_performance", "arf_feedback")
    g.add_edge("arf_feedback", END)

    compiled = g.compile()
    logger.info("[Verify V2] Compiled")
    return compiled


def get_verify_graph():
    global _verify_graph_singleton
    if _verify_graph_singleton is None:
        _verify_graph_singleton = build_verify_graph()
    return _verify_graph_singleton


async def run_verify_v2(
    run_date: str = "",
    lookback_days: int = 5,
    limit: int = 200,
    update_aggregates: bool = False,
) -> dict:
    if not run_date:
        tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
        run_date = tw_now.strftime("%Y-%m-%d")

    initial_state: VerifyStateV2 = {
        "run_date": run_date,
        "lookback_days": lookback_days,
        "limit": limit,
        "update_aggregates": update_aggregates,
        "metrics": {},
        "errors": [],
    }

    t0 = datetime.now(timezone.utc)
    graph = get_verify_graph()

    try:
        final_state = await graph.ainvoke(initial_state)
    except Exception as e:
        logger.error("[Verify V2] Graph ainvoke failed: %s", e, exc_info=True)
        return {"status": "error", "run_date": run_date, "errors": [str(e)]}

    duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    status = "error" if final_state.get("errors") else "ok"

    return {
        "status": status,
        "run_date": run_date,
        "pending": final_state.get("pending", 0),
        "verified": final_state.get("verified", 0),
        "correct": final_state.get("correct", 0),
        "total_pnl_pct": final_state.get("total_pnl_pct", 0.0),
        "model_accuracy_groups": final_state.get("model_accuracy_groups", 0),
        "trade_performance_groups": final_state.get("trade_performance_groups", 0),
        "arf_updated": final_state.get("arf_updated", 0),
        "metrics": {
            **final_state.get("metrics", {}),
            "total_duration_ms": duration_ms,
        },
        "errors": final_state.get("errors", []),
    }
