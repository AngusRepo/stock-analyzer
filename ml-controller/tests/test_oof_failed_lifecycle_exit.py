"""FU2: a failed OOF lifecycle must end the Cloud Run execution non-zero and settle as error."""
import asyncio
import re
from pathlib import Path

import pytest

import oof_materialize_job_main as job

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def run_job(monkeypatch):
    callbacks = []

    async def callback(payload):
        callbacks.append(payload)

    monkeypatch.setattr(job, '_callback_worker', callback)
    for key, value in {'MODE': 'oof_lifecycle', 'CADENCE': 'daily', 'END_DATE': '2026-10-23',
                       'RUN_ID': 'run-fu2', 'CONTINUATION_ATTEMPT': '0'}.items():
        monkeypatch.setenv('OOF_MATERIALIZE_' + key, value)

    def run(result):
        async def lifecycle(**_kwargs):
            return dict(result)
        monkeypatch.setattr(job, '_execute_lifecycle', lifecycle)
        return asyncio.run(job._run()), callbacks[-1]
    return run


@pytest.mark.parametrize('result,reason', [
    # 10/22-23: forward refresh failed on every watchdog tick, each reported "triggered" and exit 0.
    ({'status': 'failed', 'dependency_retry_required': True, 'reason': 'l4_forward_refresh_failed',
      'accounting_status': 'native_l4_daily_accounted'}, 'l4_forward_refresh_failed'),
    ({'status': 'failed', 'dependency_retry_required': True, 'nav_retry_required': True,
      'reason': 'paired_nav_daily_closure_incomplete'}, 'paired_nav_daily_closure_incomplete'),
    ({'status': 'failed', 'reason': 'l4_r2_pair_parent_changed'}, 'l4_r2_pair_parent_changed'),
])
def test_failed_lifecycle_exits_nonzero_and_settles_error(run_job, result, reason):
    code, callback = run_job(result)
    assert code == 1
    assert callback['status'] == 'error'
    assert f'oof_lifecycle_failed:{reason}' in callback['error']
    assert callback['metadata']['lifecycle_status'] == 'failed'
    if result.get('dependency_retry_required'):
        assert callback['metadata']['dependency_retry_reason'] == reason


@pytest.mark.parametrize('status,message', [
    # single-B: no morning plan while forward data is still pending.
    ('blocked', 'oof_daily_blocked:plan_missing:awaiting=paper_plan_activation'),
    ('idempotent_complete', 'oof_lifecycle_idempotent_complete_not_continuable:plan_missing'),
    ('native_l4_daily_accounted', 'oof_lifecycle_native_l4_daily_accounted_not_continuable:plan_missing'),
])
def test_retry_flag_on_a_status_the_worker_does_not_continue_is_terminal(run_job, status, message):
    code, callback = run_job({'status': status, 'dependency_retry_required': True, 'reason': 'plan_missing'})
    assert (code, callback['status']) == (1, 'error')
    assert message in callback['error']


@pytest.mark.parametrize('status', ['pending', 'spawned', 'materialized', 'shadow_evaluated'])
def test_retry_flag_on_a_continued_status_stays_triggered(run_job, status):
    code, callback = run_job({'status': status, 'dependency_retry_required': True, 'reason': 'waiting'})
    assert (code, callback['status']) == (0, 'triggered')


def test_retryable_pending_still_continues(run_job):
    code, callback = run_job({'status': 'pending', 'dependency_retry_required': True,
                              'reason': 'l4_native_inference_pending'})
    assert (code, callback['status']) == (0, 'triggered')


def test_job_never_reports_triggered_for_a_lifecycle_the_worker_will_not_continue():
    """The Worker continues only these lifecycle states; anything else must be terminal."""
    route = (ROOT / 'worker' / 'src' / 'routes' / 'adminControlRoutes.ts').read_text()
    gate = re.search(r"&& \[([^\]]+)\]\.includes\(lifecycleStatus\)", route)
    assert gate, 'Worker continuation gate moved'
    continued = set(re.findall(r"'([a-z_]+)'", gate.group(1)))
    assert continued == job.WORKER_CONTINUED_LIFECYCLE_STATUSES
