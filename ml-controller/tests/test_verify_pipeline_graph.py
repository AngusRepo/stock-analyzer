from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graphs import verify_pipeline  # noqa: E402


@pytest.mark.asyncio
async def test_verify_pipeline_runs_discrete_graph_nodes(monkeypatch):
    calls: list[str] = []

    async def _noop_arf(items):
        calls.append("arf_feedback")
        return [{"status": "ok"} for _ in items]

    monkeypatch.setattr(
        verify_pipeline.verify_service,
        "load_pending_predictions",
        lambda lookback_days, limit: calls.append("load_pending") or [{"id": 1}],
    )
    monkeypatch.setattr(
        verify_pipeline.verify_service,
        "load_market_risk",
        lambda: calls.append("load_market_risk") or {"risk_level": "low"},
    )
    monkeypatch.setattr(
        verify_pipeline.verify_service,
        "prepare_verification_updates",
        lambda pending, market_risk: calls.append("simulate_predictions") or {
            "verify_updates": [{"bind": [None, None, None, None, 1, None, None, None, None, None, 0.02]}],
            "arf_feedback_items": [{"prediction_id": 1}],
            "errors": [],
        },
    )
    monkeypatch.setattr(
        verify_pipeline.verify_service,
        "write_verified_predictions",
        lambda updates: calls.append("write_verified") or len(updates),
    )
    monkeypatch.setattr(
        verify_pipeline.verify_service,
        "update_model_accuracy",
        lambda: calls.append("update_model_accuracy") or 2,
    )
    monkeypatch.setattr(
        verify_pipeline.verify_service,
        "update_trade_performance",
        lambda: calls.append("update_trade_performance") or 3,
    )
    monkeypatch.setattr(verify_pipeline, "batch_update_arf", _noop_arf)

    graph = verify_pipeline.build_verify_graph()
    state = await graph.ainvoke({
        "run_date": "2026-04-27",
        "lookback_days": 5,
        "limit": 10,
        "metrics": {},
        "errors": [],
    })

    assert calls == [
        "load_pending",
        "load_market_risk",
        "simulate_predictions",
        "write_verified",
        "update_model_accuracy",
        "update_trade_performance",
        "arf_feedback",
    ]
    assert state["pending"] == 1
    assert state["verified"] == 1
    assert state["correct"] == 1
    assert state["model_accuracy_groups"] == 2
    assert state["trade_performance_groups"] == 3
    assert state["arf_updated"] == 1
