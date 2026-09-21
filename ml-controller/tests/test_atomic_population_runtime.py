import json
from types import SimpleNamespace
import pytest
from services import atomic_population_runtime as runtime


def test_node_host_uses_original_request_and_bounded_file_output(tmp_path, monkeypatch):
    runner = tmp_path / 'atomic.cjs'
    runner.write_text('// fixture')
    monkeypatch.setenv('ATOMIC_POPULATION_RUNNER', str(runner))
    request = {'signalDate':'2026-09-21', 'producerRunId':'pinned', 'decisionDeadline':'2026-09-21T16:00:00Z'}
    def run(command, **kwargs):
        assert command[-1] == str(runner)
        assert '--max-old-space-size=2048' in command
        assert json.loads(kwargs['input']) == request
        assert kwargs['timeout'] == 900 and kwargs['stdout'] != runtime.subprocess.PIPE
        kwargs['stdout'].write(b'{"schema_version":"atomic-canonical-population-v1","replacements":[]}')
        return SimpleNamespace(returncode=0, stderr=b'')
    monkeypatch.setattr(runtime.subprocess, 'run', run)
    assert runtime.read_population(request)['replacements'] == []


def test_missing_or_failed_node_host_never_falls_back_to_worker(tmp_path, monkeypatch):
    runner = tmp_path / 'atomic.cjs'
    monkeypatch.setenv('ATOMIC_POPULATION_RUNNER', str(runner))
    with pytest.raises(RuntimeError, match='runner_missing'):
        runtime.read_population({})
    runner.write_text('// fixture')
    monkeypatch.setattr(runtime.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=1, stderr=b'checksum_mismatch'))
    with pytest.raises(RuntimeError, match='checksum_mismatch'):
        runtime.read_population({})
