"""finlab_v4_backfill: per-call output directory, capture deadline and the error callback text."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


@pytest.fixture
def backfill(monkeypatch, tmp_path):
    import modal_app
    from app import gcs_preflight
    from google.cloud import storage
    from tools import finlab_capture_guard, finlab_gcs_upload, finlab_v4_remote_backfill

    callbacks, calls = [], []
    monkeypatch.setattr(modal_app, '_setup_env', lambda: None)
    monkeypatch.setattr(modal_app, '_post_worker_scheduler_callback',
                        lambda payload, result, status, summary, duration_ms, error=None, **kw:
                        callbacks.append({'task': payload.get('callback_task'), 'status': status,
                                          'summary': summary, 'error': error}) or {'status': 'ok'})
    monkeypatch.setattr(storage, 'Client', lambda: type('Client', (), {'bucket': lambda self, name: name})())
    monkeypatch.setattr(gcs_preflight, 'verify_gcs_object_lifecycle', lambda bucket, **kw: {'status': 'pass'})
    monkeypatch.setattr(finlab_gcs_upload, 'verify_capture_upload', lambda bucket: {'status': 'pass'})

    def run(payload, main):
        monkeypatch.setattr(finlab_v4_remote_backfill, 'main', main)
        function = modal_app.finlab_v4_backfill
        raw = function.get_raw_f() if hasattr(function, 'get_raw_f') else function._raw_f_
        base = {'run_id': 'finlab-v4-daily-20261116-1', 'gcs_bucket': 'b', 'write_d1': False,
                'output_dir': str(tmp_path), 'continue_evening_chain': True}
        return raw({**base, **payload})

    def composition_main():
        """The producer's guard (daily_inference_producer: inference/ must not exist yet)."""
        argv = sys.argv
        run_dir = Path(argv[argv.index('--output-dir') + 1]) / argv[argv.index('--run-id') + 1]
        run_dir.mkdir(parents=True, exist_ok=True)
        calls.append({'run_dir': run_dir, 'remaining': finlab_capture_guard.remaining_seconds()})
        if (run_dir / 'inference').exists():
            raise ValueError('daily_composition_output_already_exists')
        (run_dir / 'inference').mkdir()
        print(json.dumps({'run_id': run_dir.name, 'backfill_status': 'ready', 'summary': {'finlab_rows': 1}}))
        return 0

    return run, composition_main, callbacks, calls, finlab_capture_guard


def test_same_run_id_resend_on_a_warm_container_gets_a_fresh_directory(backfill, tmp_path):
    run, composition_main, callbacks, calls, _ = backfill
    first = run({'dispatch_attempt': 1}, composition_main)
    # PR #207 resends the same run_id; a queued resend can land on this container while it is still warm.
    second = run({'dispatch_attempt': 2}, composition_main)
    again = run({'dispatch_attempt': 2}, composition_main)
    assert [first['status'], second['status'], again['status']] == ['success'] * 3, callbacks
    dirs = [call['run_dir'] for call in calls]
    assert len(set(dirs)) == 3 and {d.name for d in dirs} == {'finlab-v4-daily-20261116-1'}
    assert all(d.parent.parent == tmp_path and d.parent.name.startswith('attempt-') for d in dirs)
    # Each call removes only its own directory.
    assert not any(d.parent.exists() for d in dirs) and tmp_path.exists()


def test_capture_deadline_is_bounded_and_cleared(backfill):
    run, composition_main, _, calls, guard = backfill
    run({}, composition_main)
    run({'continue_evening_chain': False}, composition_main)
    run({'capture_deadline_seconds': 5}, composition_main)
    run({'capture_deadline_seconds': 99999, 'continue_evening_chain': False}, composition_main)
    budgets = [call['remaining'] for call in calls]
    for remaining, budget in zip(budgets, (3600, 6600, 60, 6600)):
        assert budget - 30 < remaining <= budget
    assert guard.remaining_seconds() is None


def test_error_callback_carries_the_classifier_head_and_the_failing_frames(backfill, capsys):
    run, _, callbacks, _, _ = backfill

    def upload_failure():
        raise requests.exceptions.ConnectionError(
            ('Connection aborted.', TimeoutError('The write operation timed out')))
    result = run({}, upload_failure)
    head = "ConnectionError: ('Connection aborted.', TimeoutError('The write operation timed out'))"
    final = [c for c in callbacks if c['status'] == 'error' and c['task'] != 'finlab-progress']
    assert len(final) == 1 and final[0]['summary'] == head
    assert final[0]['error'].startswith(head + ' | trace: ') and 'in upload_failure' in final[0]['error']
    assert result['status'] == 'error' and result['error'] == final[0]['error']
    assert 'in upload_failure' in result['trace']
    logged = capsys.readouterr().err
    assert '[finlab_v4_backfill] error run_id=finlab-v4-daily-20261116-1' in logged and 'Traceback' in logged
