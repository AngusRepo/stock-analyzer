from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import pytest

google_cloud = sys.modules.setdefault('google.cloud', types.ModuleType('google.cloud'))
if not hasattr(google_cloud, 'run_v2'):
    run_v2_stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
    setattr(google_cloud, 'run_v2', run_v2_stub)
    sys.modules.setdefault('google.cloud.run_v2', run_v2_stub)

import optuna_job_main  # noqa: E402
from routers import optuna  # noqa: E402


def test_research_sweep_route_propagates_scheduler_ticket_identity(monkeypatch):
    captured = {}

    def fake_run_job(*, env_overrides):
        captured.update(env_overrides)
        return SimpleNamespace(
            execution_id='optuna-research-sweep-ticket-test',
            execution_name='projects/p/locations/asia-east1/jobs/j/executions/ticket-test',
        )

    monkeypatch.setattr(optuna._optuna_jobs_client, 'run_job', fake_run_job)
    result = optuna.trigger_research_sweep_job(optuna.OptunaResearchSweepReq(
        cadence='weekly',
        n_trials=1,
        subset_size=50,
        ga_population_size=6,
        ga_generations=1,
        scheduler_ticket_id='scheduler-ticket-v1-test',
        scheduler_run_id='weekly-optuna-run-test',
    ))

    assert result['status'] == 'triggered'
    assert captured['OPTUNA_SCHEDULER_TICKET_ID'] == 'scheduler-ticket-v1-test'
    assert captured['OPTUNA_SCHEDULER_RUN_ID'] == 'weekly-optuna-run-test'


@pytest.mark.asyncio
async def test_research_sweep_job_callback_preserves_scheduler_ticket_identity(monkeypatch):
    callback_payload = {}

    async def fake_sweep(_req):
        return ({
            'status': 'completed',
            'failures': [],
            'results': [],
            'staging': {},
            'ga_closure': {},
        }, 1)

    async def fake_callback(payload):
        callback_payload.update(payload)

    monkeypatch.setattr(optuna_job_main, '_execute_research_sweep_with_bounded_retry', fake_sweep)
    monkeypatch.setattr(optuna_job_main, '_callback_optuna_with_bounded_retry', fake_callback)
    monkeypatch.setenv('OPTUNA_JOB_MODE', 'research_sweep')
    monkeypatch.setenv('OPTUNA_CADENCE', 'weekly')
    monkeypatch.setenv('CLOUD_RUN_EXECUTION', 'optuna-research-sweep-ticket-test')
    monkeypatch.setenv('OPTUNA_SCHEDULER_TICKET_ID', 'scheduler-ticket-v1-test')
    monkeypatch.setenv('OPTUNA_SCHEDULER_RUN_ID', 'weekly-optuna-run-test')

    exit_code = await optuna_job_main._run()

    assert exit_code == 0
    assert callback_payload['task'] == 'weekly-optuna'
    assert callback_payload['status'] == 'success'
    assert callback_payload['scheduler_ticket_id'] == 'scheduler-ticket-v1-test'
    assert callback_payload['scheduler_run_id'] == 'weekly-optuna-run-test'
