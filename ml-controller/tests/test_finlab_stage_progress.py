import ast
import json
import os
from pathlib import Path
import sys
import types
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.finlab_stage_progress import StageProgress, install, reset, start_phase


def test_only_one_phase_running_and_elapsed_is_per_phase(monkeypatch):
    ticks = iter([10, 13, 20, 25, 30, 37])
    monkeypatch.setattr('tools.finlab_stage_progress.time.monotonic', lambda: next(ticks))
    snapshots = []
    p = StageProgress('run', '2026-10-16', 1, snapshots.append)
    p.start('acquire'); p.start('validate'); p.start('publish'); p.finish()
    assert [r['elapsed_ms'] for r in p.rows] == [3000, 5000, 7000]
    assert all(sum(r['status'] == 'running' for r in s['phases']) <= 1 for s in snapshots)
    assert all(r['status'] == 'completed' for r in snapshots[-1]['phases'])
    assert [s['sequence'] for s in snapshots] == list(range(1, 7))


def test_failed_telemetry_does_not_interrupt_work_or_leak_secret(capsys):
    def fail(_): raise RuntimeError('secret-value')
    p = StageProgress('run', '2026-10-16', 1, fail)
    token = install(p)
    try:
        start_phase('acquire'); start_phase('validate'); p.finish('failed')
    finally:
        reset(token)
    start_phase('publish')  # no instrumentation outside the owning invocation
    assert p.rows[-1]['status'] == 'failed'
    assert 'secret-value' not in capsys.readouterr().err


@pytest.mark.parametrize('outcome', ['success', 'data_error', 'callback_error'])
def test_modal_owner_preserves_business_result_and_reports_stage_terminal(monkeypatch, outcome):
    monkeypatch.setattr(os, 'environ', os.environ.copy())
    source = ast.parse((ROOT/'ml-service/modal_app.py').read_text(encoding='utf-8'))
    fn = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'finlab_v4_backfill')
    fn.decorator_list = []
    callbacks = []
    def callback(payload, result, status, *args, **kwargs):
        callbacks.append((payload['callback_task'], status, result.get('stage_progress')))
        return {'status': 'error' if outcome == 'callback_error' and payload['callback_task'] != 'finlab-progress' else 'ok'}
    def main():
        start_phase('validate')
        if outcome == 'data_error': raise ValueError('data_invalid')
        start_phase('publish')
        print(json.dumps({'run_id':'run', 'backfill_status':'ready'}))
        return 0
    fake = types.ModuleType('tools.finlab_v4_remote_backfill'); fake.main = main
    monkeypatch.setitem(sys.modules, 'tools.finlab_v4_remote_backfill', fake)
    import tools
    monkeypatch.setattr(tools, 'finlab_v4_remote_backfill', fake, raising=False)
    preflight = types.ModuleType('app.gcs_preflight'); preflight.verify_gcs_object_lifecycle = Mock(return_value={})
    monkeypatch.setitem(sys.modules, 'app.gcs_preflight', preflight)
    upload = types.ModuleType('tools.finlab_gcs_upload'); upload.verify_capture_upload = Mock(return_value={})
    monkeypatch.setitem(sys.modules, 'tools.finlab_gcs_upload', upload)
    import google.cloud.storage
    monkeypatch.setattr(google.cloud.storage, 'Client', Mock())
    env = {'os': os, '_setup_env': lambda: None, '_get_gcs_bucket_name': lambda: 'test',
           '_post_worker_scheduler_callback': callback}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), 'modal-owner', 'exec'), env)
    result = env['finlab_v4_backfill']({'run_id':'run','run_date':'2026-10-16',
        'callback_task':'finlab-v4-backfill','write_d1':False})
    expected = 'failed' if outcome == 'data_error' else 'waiting' if outcome == 'callback_error' else 'completed'
    assert result['stage_progress']['phases'][-1]['status'] == expected, result.get('error')
    assert result['status'] == ('error' if outcome == 'data_error' else 'success')
    assert all(sum(r['status']=='running' for r in p['phases']) <= 1 for _,_,p in callbacks if p)
