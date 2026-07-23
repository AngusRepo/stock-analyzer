from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

google_cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
if not hasattr(google_cloud, "run_v2"):
    run_v2_stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
    setattr(google_cloud, "run_v2", run_v2_stub)
    sys.modules.setdefault("google.cloud.run_v2", run_v2_stub)
import optuna_job_main  # noqa: E402
from routers import config_pool  # noqa: E402
from services.cloud_run_jobs_client import JobExecution  # noqa: E402


def _candidate_row() -> dict:
    return {
        "candidate_id": "parameter:research_sweep:run-1",
        "source": "research_sweep",
        "sandbox_id": "trading:config:sandbox:research_sweep:run-1",
        "metadata_json": json.dumps({"source_names": ["barrier", "signal"]}),
        "cadence": "weekly",
        "run_id": "weekly-run-1",
        "status": "SHADOW_COLLECTING",
    }


def test_trigger_validation_reuses_optuna_job_with_mode_override(monkeypatch):
    captured: dict = {}

    class FakeClient:
        def __init__(self, job_name: str):
            captured["job_name"] = job_name

        def run_job(self, env_overrides, reject_if_running):
            captured["env"] = env_overrides
            captured["reject_if_running"] = reject_if_running
            return JobExecution("projects/p/locations/r/jobs/j/executions/j-abc", "j-abc")

    import services.cloud_run_jobs_client as jobs_client

    monkeypatch.setattr(jobs_client, "CloudRunJobsClient", FakeClient)
    result = config_pool.trigger_parameter_candidates_validation_chain_job(
        config_pool.ParameterCandidateValidationChainRequest(
            candidate_ids=["parameter:research_sweep:run-1"],
            cadence="weekly",
            run_date="2026-07-23",
            run_id="weekly-run-1",
        )
    )

    assert result["status"] == "triggered"
    assert captured["job_name"] == config_pool.PARAMETER_VALIDATION_JOB_NAME
    assert captured["reject_if_running"] is False
    assert captured["env"]["OPTUNA_JOB_MODE"] == "parameter_validation"
    assert json.loads(captured["env"]["PARAMETER_VALIDATION_CANDIDATE_IDS"]) == [
        "parameter:research_sweep:run-1"
    ]


@pytest.mark.asyncio
async def test_candidate_validation_persists_pass_packet_for_cscv(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    async def fake_worker(path: str, method: str = "GET", json_body=None, **_kwargs):
        calls.append((path, method, json_body))
        if path.startswith("/api/admin/config/parameter-candidates"):
            return {"success": True}
        if path == "/api/admin/config":
            return {"position": {"maxPositions": 5}}
        if path.startswith("/api/admin/config/sandbox/"):
            return {"source": "research_sweep", "config": {"position": {"maxPositions": 6}}}
        if path == "/api/internal/d1/batch":
            return {"ok": True}
        raise AssertionError(path)

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker)
    monkeypatch.setattr(config_pool, "_load_parameter_candidate_rows", lambda *_args: [_candidate_row()])
    monkeypatch.setattr(
        config_pool,
        "run_parameter_candidate_evidence",
        lambda *_args, **_kwargs: {
            "pbo": {"method": "cscv_rank_logit"},
            "gate": {
                "decision": "PASS",
                "passed": True,
                "failed_gates": [],
                "validation_packet": {"decision": "PASS"},
                "inputs": {"pbo": {"method": "cscv_rank_logit"}},
            },
        },
    )

    result = await config_pool.parameter_candidates_validation_chain(
        config_pool.ParameterCandidateValidationChainRequest(
            candidate_ids=["parameter:research_sweep:run-1"],
            run_date="2026-07-23",
            run_id="weekly-run-1",
        )
    )

    assert result["ready"] == 1
    assert result["blocked"] == 0
    assert result["validation_run_id"] == "weekly-run-1"
    assert result["results"][0]["promotion_packet_id"].startswith("promotion_packet:")
    batch_calls = [body for path, _, body in calls if path == "/api/internal/d1/batch"]
    evidence_batch = next(body for body in batch_calls if len(body["statements"]) == 5)
    assert evidence_batch["statements"][0]["sql"].startswith("DELETE FROM parameter_candidate_evidence")
    assert evidence_batch["statements"][0]["params"][-1] == "weekly-run-1"


@pytest.mark.asyncio
async def test_candidate_validation_blocks_proxy_pbo(monkeypatch):
    async def fake_worker(path: str, method: str = "GET", json_body=None, **_kwargs):
        if path.startswith("/api/admin/config/parameter-candidates"):
            return {"success": True}
        if path == "/api/admin/config":
            return {}
        if path.startswith("/api/admin/config/sandbox/"):
            return {"source": "research_sweep", "config": {}}
        if path == "/api/internal/d1/batch":
            return {"ok": True}
        raise AssertionError(path)

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker)
    monkeypatch.setattr(config_pool, "_load_parameter_candidate_rows", lambda *_args: [_candidate_row()])
    monkeypatch.setattr(
        config_pool,
        "run_parameter_candidate_evidence",
        lambda *_args, **_kwargs: {
            "pbo": {"method": "heuristic_proxy"},
            "gate": {
                "decision": "PASS",
                "passed": True,
                "failed_gates": [],
                "validation_packet": {"decision": "PASS"},
            },
        },
    )

    result = await config_pool.parameter_candidates_validation_chain(
        config_pool.ParameterCandidateValidationChainRequest(run_date="2026-07-23", run_id="proxy-run")
    )

    assert result["ready"] == 0
    assert result["blocked"] == 1
    assert result["results"][0]["promotion_packet_id"] is None
    assert "proxy_pbo_blocked" in result["results"][0]["failed_gates"]


@pytest.mark.asyncio
async def test_optuna_job_parameter_validation_callback_owns_final_status(monkeypatch):
    callbacks: list[dict] = []

    async def fake_validation(req):
        assert req.candidate_ids == ["parameter:research_sweep:run-1"]
        return {
            "status": "completed",
            "total": 1,
            "ready": 0,
            "blocked": 1,
            "validation_run_id": req.run_id,
            "results": [{
                "candidate_id": req.candidate_ids[0],
                "source": "research_sweep",
                "status": "VALIDATION_BLOCKED",
                "decision": "FAIL",
                "promotion_packet_id": None,
                "failed_gates": ["minimum_trades"],
                "pbo_method": "cscv_rank_logit",
            }],
        }

    async def fake_callback(payload):
        callbacks.append(payload)

    monkeypatch.setattr(config_pool, "parameter_candidates_validation_chain", fake_validation)
    monkeypatch.setattr(optuna_job_main, "_callback_worker", fake_callback)
    monkeypatch.setenv("OPTUNA_JOB_MODE", "parameter_validation")
    monkeypatch.setenv("PARAMETER_VALIDATION_CANDIDATE_IDS", '["parameter:research_sweep:run-1"]')
    monkeypatch.setenv("PARAMETER_VALIDATION_RUN_ID", "weekly-run-1")
    monkeypatch.setenv("PARAMETER_VALIDATION_RUN_DATE", "2026-07-23")

    exit_code = await optuna_job_main._run()

    assert exit_code == 0
    assert callbacks[0]["task"] == "parameter-candidate-validation"
    assert callbacks[0]["status"] == "success"
    assert callbacks[0]["run_id"] == "weekly-run-1"
    assert callbacks[0]["metadata"]["blocked"] == 1
    assert callbacks[0]["metadata"]["candidate_ids"] == ["parameter:research_sweep:run-1"]