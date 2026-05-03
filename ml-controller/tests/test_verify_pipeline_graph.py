from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

sys.modules.setdefault(
    "services.cloud_run_jobs_client",
    types.SimpleNamespace(
        CloudRunJobsClient=lambda *args, **kwargs: types.SimpleNamespace(run_job=lambda **_: None),
        JobAlreadyRunningError=RuntimeError,
    ),
)

from graphs import verify_pipeline  # noqa: E402
from routers import verify as verify_router  # noqa: E402


@pytest.mark.asyncio
async def test_verify_pipeline_runs_discrete_graph_nodes(monkeypatch):
    calls: list[str] = []

    async def _noop_arf(items):
        calls.append("arf_feedback")
        return [{"status": "ok"} for _ in items]

    monkeypatch.setattr(
        verify_pipeline.verify_service,
        "load_pending_predictions",
        lambda lookback_days, limit, run_date=None: calls.append("load_pending") or [{"id": 1}],
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
        "update_aggregates": True,
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


@pytest.mark.asyncio
async def test_verify_dry_run_preview_does_not_write_or_update_arf(monkeypatch):
    calls: list[str] = []

    monkeypatch.setattr(
        verify_router.verify_service,
        "load_pending_predictions",
        lambda lookback_days, limit, run_date=None: calls.append("load_pending") or [{"id": 1}],
    )
    monkeypatch.setattr(
        verify_router.verify_service,
        "load_market_risk",
        lambda: calls.append("load_market_risk") or {"risk_level": "low"},
    )
    monkeypatch.setattr(
        verify_router.verify_service,
        "prepare_verification_updates",
        lambda pending, market_risk: calls.append("prepare_updates") or {
            "verify_updates": [{"bind": ["up", None, "up", 100, 1, None, "low", 0.2, 0.02, "target1", 0.03]}],
            "arf_feedback_items": [{"prediction_id": 1}],
            "errors": [],
        },
    )
    monkeypatch.setattr(
        verify_router.verify_service,
        "summarize_verification_updates",
        lambda pending_count, updates: calls.append("summarize") or {
            "pending": pending_count,
            "verified": len(updates),
            "correct": 1,
            "total_pnl_pct": 0.03,
        },
    )
    monkeypatch.setattr(
        verify_router.verify_service,
        "write_verified_predictions",
        lambda updates: (_ for _ in ()).throw(AssertionError("dry-run must not write predictions")),
    )
    monkeypatch.setattr(
        verify_router.verify_service,
        "update_model_accuracy",
        lambda: (_ for _ in ()).throw(AssertionError("dry-run must not update model accuracy")),
    )
    monkeypatch.setattr(
        verify_router.verify_service,
        "update_trade_performance",
        lambda: (_ for _ in ()).throw(AssertionError("dry-run must not update trade performance")),
    )
    monkeypatch.setattr(
        verify_router,
        "batch_update_arf",
        lambda items: (_ for _ in ()).throw(AssertionError("dry-run must not update ARF")),
    )

    result = await verify_router.post_verify_dry_run(verify_router.VerifyRunRequest(
        run_date="2026-04-30",
        lookback_days=5,
        limit=10,
    ))

    assert result["status"] == "ok"
    assert result["dry_run"] is True
    assert result["pending"] == 1
    assert result["verified"] == 1
    assert result["arf_feedback_planned"] == 1
    assert result["mutations_skipped"] == [
        "write_verified_predictions",
        "update_model_accuracy",
        "update_trade_performance",
        "batch_update_arf",
    ]
    assert calls == ["load_pending", "load_market_risk", "prepare_updates", "summarize"]
