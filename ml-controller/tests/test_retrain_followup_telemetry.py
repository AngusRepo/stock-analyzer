from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import retrain_followup as followup_router  # noqa: E402


class _Request:
    headers: dict[str, str] = {}


@pytest.mark.asyncio
async def test_retrain_followup_records_modal_runtime_telemetry(monkeypatch):
    calls: list[dict] = []

    async def fake_record_modal_call(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(followup_router, "INTERNAL_TOKEN", "")
    monkeypatch.setattr(followup_router.d1_client, "execute", lambda *args, **kwargs: {"meta": {"changes": 1}})
    monkeypatch.setattr(followup_router.retrain_lock, "release", lambda key: True)
    monkeypatch.setattr(followup_router, "record_modal_call", fake_record_modal_call)

    payload = followup_router.RetrainFollowupPayload(
        run_id="run-telemetry",
        lock_key="lock-telemetry",
        status="completed",
        modal_telemetry=[
            {
                "function_name": "retrain_orchestrator",
                "compute_sec": 300.2,
                "wall_sec": 300.2,
                "meta": {"stage": "orchestrator"},
            },
            {
                "function_name": "train_ftt_model",
                "compute_sec": 125.7,
                "wall_sec": 125.7,
                "meta": {"group": "ftt"},
            },
            {
                "function_name": "train_tree_models",
                "compute_sec": 0,
            },
        ],
    )

    result = await followup_router.retrain_followup(payload, _Request())

    assert result["status"] == "completed"
    assert result["modal_telemetry"]["recorded"] == 2
    assert [c["function_name"] for c in calls] == ["retrain_orchestrator", "train_ftt_model"]
    assert calls[0]["source"] == "modal_followup"
    assert calls[1]["gpu"] == "L4"
    assert calls[1]["memory_mb"] == 4096
    assert calls[1]["meta"]["group"] == "ftt"
