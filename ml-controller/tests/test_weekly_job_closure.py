from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

try:
    import google.cloud as google_cloud
except ImportError:
    google_cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
if not hasattr(google_cloud, "run_v2"):
    run_v2_stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
    setattr(google_cloud, "run_v2", run_v2_stub)
    sys.modules.setdefault("google.cloud.run_v2", run_v2_stub)

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import optuna_job_main
from routers import backtest, optuna
from services import cloud_run_jobs_client, monte_carlo_service, pbo_service, weekly_evidence_service
CANONICAL_WEEKLY_RUN_ID = "weekly-backtest-2026-08-23-1787500000000-abcdef123456"


@pytest.mark.asyncio
async def test_backtest_research_bundle_dispatches_cloud_run_job(monkeypatch):
    captured: dict = {}

    class FakeExecution:
        execution_id = "optuna-research-sweep-test"
        execution_name = "projects/p/locations/r/jobs/j/executions/optuna-research-sweep-test"

    class FakeClient:
        def __init__(self, *, job_name: str):
            captured["job_name"] = job_name

        def run_job(self, *, env_overrides: dict[str, str], reject_if_running: bool):
            captured["env"] = env_overrides
            captured["reject_if_running"] = reject_if_running
            return FakeExecution()

    monkeypatch.setattr(cloud_run_jobs_client, "CloudRunJobsClient", FakeClient)
    monkeypatch.setattr(backtest, "BACKTEST_RESEARCH_JOB_NAME", "weekly-backtest-research")
    result = await backtest.trigger_weekly_backtest_research_bundle(
        backtest.WeeklyBacktestResearchBundleRequest(run_date="2026-08-23", run_id=CANONICAL_WEEKLY_RUN_ID)
    )

    assert result["status"] == "triggered"
    assert captured["job_name"] == "weekly-backtest-research"
    assert result["task"] == "weekly-backtest"
    assert result["execution_id"] == "optuna-research-sweep-test"
    assert captured["env"]["OPTUNA_JOB_MODE"] == "weekly_backtest"
    assert captured["env"]["OPTUNA_RUN_DATE"] == "2026-08-23"
    assert captured["env"]["OPTUNA_RUN_ID"] == CANONICAL_WEEKLY_RUN_ID
    assert result["run_id"] == CANONICAL_WEEKLY_RUN_ID
    assert captured["reject_if_running"] is True


def test_backtest_research_bundle_rejects_noncanonical_run_id():
    with pytest.raises(ValidationError):
        backtest.WeeklyBacktestResearchBundleRequest(
            run_date="2026-08-23",
            run_id="generated-by-controller",
        )


@pytest.mark.asyncio
async def test_backtest_research_bundle_rejects_run_id_date_mismatch():
    with pytest.raises(HTTPException) as raised:
        await backtest.trigger_weekly_backtest_research_bundle(
            backtest.WeeklyBacktestResearchBundleRequest(
                run_date="2026-08-23",
                run_id="weekly-backtest-2026-08-16-1787500000000-abcdef123456",
            )
        )

    assert raised.value.status_code == 422
    assert raised.value.detail["error"] == "weekly_backtest_run_id_date_mismatch"

@pytest.mark.asyncio
async def test_backtest_research_bundle_rejects_duplicate_running_execution(monkeypatch):
    execution = cloud_run_jobs_client.JobExecution(
        execution_name="projects/p/locations/r/jobs/j/executions/weekly-backtest-research-live",
        execution_id="weekly-backtest-research-live",
    )

    class FakeClient:
        def __init__(self, *, job_name: str):
            assert job_name == "weekly-backtest-research"

        def run_job(self, *, env_overrides: dict[str, str], reject_if_running: bool):
            assert reject_if_running is True
            raise cloud_run_jobs_client.JobAlreadyRunningError(execution)

    monkeypatch.setattr(cloud_run_jobs_client, "CloudRunJobsClient", FakeClient)
    monkeypatch.setattr(backtest, "BACKTEST_RESEARCH_JOB_NAME", "weekly-backtest-research")

    with pytest.raises(HTTPException) as raised:
        await backtest.trigger_weekly_backtest_research_bundle(
            backtest.WeeklyBacktestResearchBundleRequest(run_date="2026-08-23", run_id=CANONICAL_WEEKLY_RUN_ID)
        )

    assert raised.value.status_code == 409
    assert raised.value.detail["error"] == "weekly_backtest_research_execution_already_running"
    assert raised.value.detail["execution_id"] == execution.execution_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("pbo_source_row_id", "expected_status", "expected_error"),
    [
        ("bt-823", "completed", None),
        ("bt-stale", "error", "immutable_pbo_backtest_lineage_mismatch"),
    ],
)
async def test_weekly_reconcile_fences_pbo_to_same_backtest(
    monkeypatch,
    pbo_source_row_id,
    expected_status,
    expected_error,
):
    evidence_clock = {
        "schema_version": "weekly-evidence-clock-v1",
        "as_of_date": "2026-08-23",
        "mode": "B",
        "research_data_source": "snapshot",
        "evidence_scope": "canonical_current",
        "look_ahead_check": "PASS",
        "production_effect": True,
        "data_end_date": "2026-08-21",
        "snapshot_business_date": "2026-08-21",
    }

    async def fake_query(_client, sql, params, *, domain):
        assert params == ["2026-08-23"]
        assert str(domain.value) == "research"
        if "FROM backtest_results" in sql:
            return [{
                "id": "bt-823",
                "total_trades": 90,
                "raw_results": json.dumps({"strategy_lab_record": {"evidence_clock": evidence_clock}}),
            }]
        if "FROM monte_carlo_results" in sql:
            return [
                {
                    "id": "mc-paper-823",
                    "source": "paper",
                    "go_live_verdict": "PASS",
                    "raw_distribution": json.dumps({"tail_risk_status": "FULL_SAMPLE_TAIL_RISK"}),
                },
                {
                    "id": "mc-backtest-823",
                    "source": "backtest",
                    "go_live_verdict": "PASS",
                    "raw_distribution": json.dumps({
                        "tail_risk_status": "FULL_SAMPLE_TAIL_RISK",
                        "source_provenance": {
                            "source_row_id": "bt-823",
                            "source_run_date": "2026-08-23",
                        },
                    }),
                },
            ]
        if "FROM pbo_results" in sql:
            return [{
                "id": "pbo-823",
                "source": "backtest",
                "go_live_verdict": "PASS",
                "raw_details": json.dumps({
                    "source_provenance": {
                        "source_row_id": pbo_source_row_id,
                        "source_run_date": "2026-08-23",
                    },
                }),
            }]
        raise AssertionError(sql)

    class FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    monkeypatch.setattr(monte_carlo_service, "_d1_query", fake_query)
    monkeypatch.setattr(monte_carlo_service, "httpx", types.SimpleNamespace(AsyncClient=FakeAsyncClient))

    result = await backtest.reconcile_weekly_backtest_research_bundle(
        backtest.WeeklyBacktestEvidenceReconciliationRequest(run_date="2026-08-23")
    )

    assert result["status"] == expected_status
    if expected_error:
        assert result["error"] == expected_error
    else:
        assert result["execution_status"] == "success"
        assert result["validation_status"] == "passed"


@pytest.mark.asyncio
async def test_weekly_callback_uses_canonical_dispatch_run_id(monkeypatch):
    callback_payload: dict = {}

    async def fake_bundle(run_date: str):
        return {
            "status": "completed",
            "run_date": run_date,
            "validation_status": "passed",
            "promotion_gate_eligible": True,
            "blockers": [],
            "pbo": {},
            "summary": "done",
        }

    async def fake_callback(payload):
        callback_payload.update(payload)

    monkeypatch.setattr(optuna_job_main, "_run_weekly_backtest_bundle", fake_bundle)
    monkeypatch.setattr(optuna_job_main, "_callback_weekly_with_bounded_retry", fake_callback)
    monkeypatch.setenv("OPTUNA_JOB_MODE", "weekly_backtest")
    monkeypatch.setenv("OPTUNA_RUN_DATE", "2026-08-23")
    monkeypatch.setenv("OPTUNA_RUN_ID", "weekly-backtest-2026-08-23-canonical")
    monkeypatch.setenv("CLOUD_RUN_EXECUTION", "weekly-backtest-research-execution")

    exit_code = await optuna_job_main._run()

    assert exit_code == 0
    assert callback_payload["run_id"] == "weekly-backtest-2026-08-23-canonical"
    assert callback_payload["run_date"] == "2026-08-23"


@pytest.mark.asyncio
async def test_weekly_callback_retries_transient_failure_with_bound(monkeypatch):
    calls = 0
    sleeps: list[int] = []

    async def flaky_callback(_payload):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise optuna_job_main.CallbackWorkerError("Worker scheduler callback HTTP 503")

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(optuna_job_main, "_callback_worker", flaky_callback)
    monkeypatch.setattr(optuna_job_main.asyncio, "sleep", fake_sleep)
    monkeypatch.setenv("WEEKLY_BACKTEST_CALLBACK_MAX_ATTEMPTS", "3")

    await optuna_job_main._callback_weekly_with_bounded_retry({"task": "weekly-backtest"})

    assert calls == 3
    assert sleeps == [1, 2]


@pytest.mark.asyncio
async def test_weekly_callback_does_not_retry_stale_4xx(monkeypatch):
    calls = 0

    async def stale_callback(_payload):
        nonlocal calls
        calls += 1
        raise optuna_job_main.CallbackWorkerError("Worker scheduler callback HTTP 409")

    monkeypatch.setattr(optuna_job_main, "_callback_worker", stale_callback)

    with pytest.raises(optuna_job_main.CallbackWorkerError):
        await optuna_job_main._callback_weekly_with_bounded_retry({"task": "weekly-backtest"})

    assert calls == 1


@pytest.mark.asyncio
async def test_optuna_callback_retries_rate_limit_to_durable_closure(monkeypatch):
    calls = 0
    sleeps: list[int] = []

    async def rate_limited_callback(_payload):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise optuna_job_main.CallbackWorkerError("Worker scheduler callback HTTP 429")

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(optuna_job_main, "_callback_worker", rate_limited_callback)
    monkeypatch.setattr(optuna_job_main.asyncio, "sleep", fake_sleep)
    monkeypatch.setenv("OPTUNA_CALLBACK_MAX_ATTEMPTS", "3")

    await optuna_job_main._callback_optuna_with_bounded_retry({"task": "weekly-optuna"})

    assert calls == 2
    assert sleeps == [1]


@pytest.mark.asyncio
async def test_weekly_source_evidence_reconciliation_only_appends_no_effect_receipt(monkeypatch):
    evidence_clock = {
        "schema_version": "weekly-evidence-clock-v1",
        "as_of_date": "2026-08-23",
        "mode": "B",
        "research_data_source": "snapshot",
        "evidence_scope": "canonical_current",
        "look_ahead_check": "PASS",
        "production_effect": True,
        "data_end_date": "2026-08-21",
        "snapshot_business_date": "2026-08-21",
    }
    queries: list[str] = []

    async def fake_query(_client, sql, params, *, domain):
        queries.append(sql)
        assert params == ["2026-08-23"]
        assert str(domain.value) == "research"
        if "FROM backtest_results" in sql:
            return [{
                "id": "bt-823",
                "total_trades": 5,
                "raw_results": json.dumps({"strategy_lab_record": {"evidence_clock": evidence_clock}}),
                "created_at": "2026-08-22 22:03:49",
            }]
        if "FROM monte_carlo_results" in sql:
            return [
                {"id": "mc-paper-823", "source": "paper", "n_trades": 105,
                 "go_live_verdict": "CAUTION",
                 "raw_distribution": json.dumps({"tail_risk_status": "FULL_SAMPLE_TAIL_RISK"})},
                {"id": "mc-backtest-823", "source": "backtest", "n_trades": 352,
                 "go_live_verdict": "PASS",
                 "raw_distribution": json.dumps({"tail_risk_status": "FULL_SAMPLE_TAIL_RISK",
                                                 "source_provenance": {"source_row_id": "bt-823",
                                                                       "source_run_date": "2026-08-23"}})},
            ]
        if "FROM pbo_results" in sql:
            return []
        raise AssertionError(sql)

    class FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    receipt: dict = {}

    async def fake_receipt(_client, **kwargs):
        receipt.update(kwargs)
        return "pbo-attempt-v1-823"

    monkeypatch.setattr(monte_carlo_service, "_d1_query", fake_query)
    monkeypatch.setattr(monte_carlo_service, "httpx", types.SimpleNamespace(AsyncClient=FakeAsyncClient))
    monkeypatch.setattr(backtest, "persist_pbo_attempt_receipt", fake_receipt)

    result = await backtest.reconcile_weekly_backtest_research_bundle(
        backtest.WeeklyBacktestEvidenceReconciliationRequest(run_date="2026-08-23")
    )

    assert result["status"] == "completed"
    assert result["execution_status"] == "success"
    assert result["validation_status"] == "blocked"
    assert result["promotion_gate_eligible"] is False
    assert result["production_effect"] is False
    assert result["evidence_read_only"] is True
    assert result["source_evidence_read_only"] is True
    assert result["attempt_receipt_append_only"] is True
    assert result["attempt_receipt_materialized"] is True
    assert result["evidence_ids"]["pbo_attempt"] == "pbo-attempt-v1-823"
    assert receipt["status"] == "insufficient_evidence"
    assert receipt["observed_trades"] == 5
    assert receipt["required_trades"] == 30
    assert receipt["pbo_result_id"] is None
    assert receipt["source_provenance"]["receipt_origin"] == "read_only_source_reconciliation"
    assert "monte_carlo:paper:verdict=CAUTION" in result["blockers"]
    assert "pbo:insufficient_evidence:observed=5:required=30" in result["blockers"]
    assert len(queries) == 3


@pytest.mark.asyncio
async def test_weekly_job_completes_when_pbo_is_evidence_blocked(monkeypatch):
    monkeypatch.setattr(
        weekly_evidence_service,
        "run_canonical_weekly_backtest",
        lambda *, run_date: {"status": "success", "run_date": run_date, "total_trades": 5},
    )

    async def fake_mc(**kwargs):
        return {
            "status": "success",
            "source": kwargs["source"],
            "go_live_verdict": "PASS",
            "tail_risk_status": "FULL_SAMPLE_TAIL_RISK",
        }

    async def fake_pbo(**_kwargs):
        return {
            "status": "insufficient_evidence",
            "observed_trades": 5,
            "required_trades": 30,
            "promotion_gate_eligible": False,
            "go_live_verdict": "INSUFFICIENT_EVIDENCE",
        }

    monkeypatch.setattr(monte_carlo_service, "run_monte_carlo_mdd", fake_mc)
    monkeypatch.setattr(pbo_service, "run_pbo_analysis", fake_pbo)

    result = await optuna_job_main._run_weekly_backtest_bundle("2026-08-23")

    assert result["status"] == "completed"
    assert result["validation_status"] == "blocked"
    assert result["promotion_gate_eligible"] is False
    assert result["failures"] == []
    assert result["blockers"] == ["pbo:insufficient_evidence:observed=5:required=30"]


def test_optuna_no_feasible_pareto_is_not_an_infrastructure_error():
    def no_candidate():
        raise HTTPException(status_code=400, detail="No feasible Pareto trials out of 80")

    result = optuna._run_optuna_sweep_source_inner("screener", no_candidate)

    assert result["status"] == "skipped"
    assert "SKIPPED_NOT_READY" in result["summary"]


def test_scheduled_optuna_defaults_to_serial_source_access(monkeypatch):
    monkeypatch.delenv("OPTUNA_MAX_PARALLEL_SOURCES", raising=False)

    request = optuna_job_main._build_request()

    assert request.max_parallel_sources == 1

    monkeypatch.setenv("OPTUNA_MAX_PARALLEL_SOURCES", "2")
    assert optuna_job_main._build_request().max_parallel_sources == 2


def test_weekly_eval_requires_explicit_confirmation_before_apply():
    source = (Path(__file__).resolve().parents[1] / "routers" / "config_pool.py").read_text(encoding="utf-8")
    assert "confirm: bool = Field(default=False" in source
    assert "if req.apply and not req.confirm:" in source
    assert "weekly_eval apply=true requires confirm=true" in source


@pytest.mark.asyncio
async def test_research_sweep_retries_transient_source_failure_to_atomic_success(monkeypatch):
    calls = []
    sleeps = []

    def fake_sweep(_req):
        calls.append(len(calls) + 1)
        if len(calls) == 1:
            return {
                "status": "error",
                "failures": ["barrier:ERROR(HTTP 429 D1 overload)"],
                "staging": {"status": "blocked", "reason": "source_failure"},
            }
        return {
            "status": "completed",
            "failures": [],
            "staging": {"status": "staged", "reason": None},
        }

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(optuna_job_main, "execute_research_sweep", fake_sweep)
    monkeypatch.setattr(optuna_job_main.asyncio, "sleep", fake_sleep)
    monkeypatch.setenv("OPTUNA_SWEEP_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("OPTUNA_SWEEP_RETRY_BASE_SECONDS", "0.1")

    result, attempts = await optuna_job_main._execute_research_sweep_with_bounded_retry(
        optuna_job_main._build_request()
    )

    assert attempts == 2
    assert result["status"] == "completed"
    assert result["staging"]["status"] == "staged"
    assert result["attempt_count"] == 2
    assert len(sleeps) == 1


@pytest.mark.asyncio
async def test_research_sweep_does_not_retry_permanent_failure(monkeypatch):
    calls = []

    def fake_sweep(_req):
        calls.append(1)
        return {
            "status": "error",
            "failures": ["ga_optimizer:ERROR(ValueError: invalid candidate schema)"],
            "staging": {"status": "blocked", "reason": "source_failure"},
        }

    monkeypatch.setattr(optuna_job_main, "execute_research_sweep", fake_sweep)
    monkeypatch.setenv("OPTUNA_SWEEP_MAX_ATTEMPTS", "3")

    result, attempts = await optuna_job_main._execute_research_sweep_with_bounded_retry(
        optuna_job_main._build_request()
    )

    assert attempts == 1
    assert result["status"] == "error"
    assert result["staging"]["status"] == "blocked"
    assert len(calls) == 1
