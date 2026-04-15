"""
verify_pipeline.py — LangGraph StateGraph for prediction verification pipeline
2026-04-08 audit Phase 5.4 (D-2 verify port)

Replaces worker predictionVerifier.ts. Runs on schedule (TW 19:00) to verify
predictions generated 5+ days ago and refresh model_accuracy / trade_performance.

Linear graph:
  load_pending
    → fetch_bars_and_simulate   (verify_service.run_verify_pipeline inner loop)
    → write_back_predictions    (batched UPDATE)
    → update_model_accuracy     (groups × periods)
    → update_trade_performance  (groups × periods)
    → arf_feedback              (POST to ml-service for LinUCB online update)
    → END

State carries summary metrics across nodes. ARF feedback is a fire-and-forget
hop (not blocking).
"""
from __future__ import annotations
import asyncio
import logging
import operator
from datetime import datetime, timezone
from typing import Annotated, Any, TypedDict

from langgraph.graph import StateGraph, END

from services import verify_service
from services.modal_client import batch_update_arf

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# State schema
# ─────────────────────────────────────────────────────────────────────────────

class VerifyStateV2(TypedDict, total=False):
    """Verify pipeline state."""
    run_date: str
    lookback_days: int
    limit: int

    # Output from verify_service.run_verify_pipeline
    pending: int
    verified: int
    correct: int
    total_pnl_pct: float
    model_accuracy_groups: int
    trade_performance_groups: int
    arf_feedback_items: list[dict]

    # ARF feedback result (optional)
    arf_updated: int

    # Metrics / errors
    metrics: dict
    errors: Annotated[list[str], operator.add]


# ─────────────────────────────────────────────────────────────────────────────
# Nodes
# ─────────────────────────────────────────────────────────────────────────────

async def node_run_verify(state: VerifyStateV2) -> dict:
    """
    Run the full verify_service pipeline in one shot.

    verify_service.run_verify_pipeline already encapsulates:
      - load_pending_predictions
      - per-prediction bar fetch + simulate_trade
      - batch write_verified_predictions
      - update_model_accuracy
      - update_trade_performance
    """
    logger.info("[Verify V2] node_run_verify")
    t0 = datetime.now(timezone.utc)

    lookback_days = int(state.get("lookback_days") or 5)
    limit = int(state.get("limit") or 200)

    # verify_service is sync (D1 REST + pure loop) → run in thread executor
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None,
            verify_service.run_verify_pipeline,
            lookback_days,
            limit,
        )
    except Exception as e:
        logger.error(f"[Verify V2] node_run_verify failed: {e}", exc_info=True)
        return {"errors": [f"verify_service failed: {e}"]}

    duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    return {
        **result,
        "metrics": {
            **(state.get("metrics") or {}),
            "verify_duration_ms": duration_ms,
        },
    }


async def node_arf_feedback(state: VerifyStateV2) -> dict:
    """
    Push ARF/LinUCB feedback to ml-service for online learning update.

    Non-blocking: failures here do not fail the verify pipeline.
    """
    logger.info("[Verify V2] node_arf_feedback")
    items = state.get("arf_feedback_items") or []
    if not items:
        return {"arf_updated": 0}

    try:
        results = await batch_update_arf(items)
        # results is a list of per-item responses from ml-service /arf/update
        updated = sum(
            1 for r in results
            if isinstance(r, dict) and (r.get("status") == "ok" or r.get("updated"))
        )
        logger.info(f"[Verify V2] ARF feedback: {updated}/{len(items)} updated")
        return {"arf_updated": updated}
    except Exception as e:
        logger.warning(f"[Verify V2] ARF feedback failed (non-blocking): {e}")
        return {"errors": [f"arf_feedback non-fatal: {e}"], "arf_updated": 0}


# ─────────────────────────────────────────────────────────────────────────────
# Build graph
# ─────────────────────────────────────────────────────────────────────────────

_verify_graph_singleton: Any = None


def build_verify_graph():
    """Build and compile the verify StateGraph."""
    g = StateGraph(VerifyStateV2)

    g.add_node("run_verify",   node_run_verify)
    g.add_node("arf_feedback", node_arf_feedback)

    g.set_entry_point("run_verify")
    g.add_edge("run_verify",   "arf_feedback")
    g.add_edge("arf_feedback", END)

    compiled = g.compile()
    logger.info("[Verify V2] Compiled")
    return compiled


def get_verify_graph():
    """Lazy singleton."""
    global _verify_graph_singleton
    if _verify_graph_singleton is None:
        _verify_graph_singleton = build_verify_graph()
    return _verify_graph_singleton


# ─────────────────────────────────────────────────────────────────────────────
# Public runner
# ─────────────────────────────────────────────────────────────────────────────

async def run_verify_v2(
    run_date: str = "",
    lookback_days: int = 5,
    limit: int = 200,
) -> dict:
    """
    Execute the verify pipeline V2.

    Args:
        run_date: TW date YYYY-MM-DD (informational only; verify logic is cutoff-based)
        lookback_days: how old predictions must be to verify (default 5)
        limit: max predictions per run (default 200)

    Returns:
        {
          status, run_date, pending, verified, correct,
          total_pnl_pct, model_accuracy_groups, trade_performance_groups,
          arf_updated, metrics, errors
        }
    """
    if not run_date:
        from datetime import timedelta
        tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
        run_date = tw_now.strftime("%Y-%m-%d")

    initial_state: VerifyStateV2 = {
        "run_date": run_date,
        "lookback_days": lookback_days,
        "limit": limit,
        "metrics": {},
        "errors": [],
    }

    t0 = datetime.now(timezone.utc)
    graph = get_verify_graph()

    try:
        final_state = await graph.ainvoke(initial_state)
    except Exception as e:
        logger.error(f"[Verify V2] Graph ainvoke failed: {e}", exc_info=True)
        return {
            "status": "error",
            "run_date": run_date,
            "errors": [str(e)],
        }

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
