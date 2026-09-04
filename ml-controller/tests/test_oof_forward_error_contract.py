import asyncio
from pathlib import Path

import oof_materialize_job_main


ROOT = Path(__file__).resolve().parents[2]


def test_forward_extension_modal_error_precedes_safety_checks():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text()
    assert source.index('if extension.get("error")') < source.index(
        'daily_forward_extension_dispatched_training'
    )


def test_oof_job_preserves_forward_extension_root_cause(monkeypatch):
    callbacks = []

    async def fake_execute_lifecycle(**_kwargs):
        return {
            "status": "pending",
            "reason": "daily_forward_extension_not_materialized",
            "dependency_retry_required": True,
            "daily_forward_extension": {
                "status": "blocked",
                "reason": "daily_forward_extension_failed:forward_extension_no_mature_rows",
            },
        }

    async def fake_callback(payload):
        callbacks.append(payload)

    monkeypatch.setattr(oof_materialize_job_main, "_execute_lifecycle", fake_execute_lifecycle)
    monkeypatch.setattr(oof_materialize_job_main, "_callback_worker", fake_callback)
    monkeypatch.setenv("OOF_MATERIALIZE_CADENCE", "daily")
    monkeypatch.setenv("OOF_MATERIALIZE_END_DATE", "2026-07-29")
    monkeypatch.setenv("OOF_MATERIALIZE_RUN_ID", "run-forward-blocked")

    assert asyncio.run(oof_materialize_job_main._run()) == 0
    assert callbacks[0]["status"] == "triggered"
    root_cause = "daily_forward_extension_failed:forward_extension_no_mature_rows"
    assert root_cause in callbacks[0]["summary"]
    assert (
        callbacks[0]["metadata"]["dependency_retry_reason"] == root_cause
    )
