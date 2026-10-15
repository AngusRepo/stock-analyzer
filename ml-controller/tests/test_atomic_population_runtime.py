import json
from types import SimpleNamespace
import pytest
from services import atomic_population_runtime as runtime

@pytest.fixture(autouse=True)
def local_only(monkeypatch):
    monkeypatch.delenv('GCS_BUCKET_NAME', raising=False)


def test_node_host_uses_original_request_and_bounded_file_output(tmp_path, monkeypatch):
    runner = tmp_path / 'atomic.cjs'
    runner.write_text('// fixture')
    monkeypatch.setenv('ATOMIC_POPULATION_RUNNER', str(runner))
    request = {'signalDate':'2026-09-21', 'producerRunId':'pinned', 'decisionDeadline':'2026-09-21T16:00:00Z'}
    def run(command, **kwargs):
        assert command[-1] == str(runner)
        assert '--max-old-space-size=2048' in command
        assert json.loads(kwargs['input']) == request
        assert kwargs['timeout'] == 1800 and kwargs['stdout'] != runtime.subprocess.PIPE
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


def test_timeout_resumes_same_checkpoint_directory_and_discards_partial_stdout(tmp_path, monkeypatch):
    runner = tmp_path / 'atomic.cjs'
    runner.write_text('// fixture')
    monkeypatch.setenv('ATOMIC_POPULATION_RUNNER', str(runner))
    calls = []
    def run(command, **kwargs):
        calls.append(kwargs['env']['ATOMIC_CHECKPOINT_DIR'])
        if len(calls) == 1:
            kwargs['stdout'].write(b'{incomplete')
            raise runtime.subprocess.TimeoutExpired(command, 1800)
        assert calls[0] == calls[1]
        assert kwargs['stdout'].tell() == 0
        kwargs['stdout'].write(b'{"schema_version":"atomic-canonical-population-v1","replacements":[]}')
        return SimpleNamespace(returncode=0, stderr=b'')
    monkeypatch.setattr(runtime.subprocess, 'run', run)
    assert runtime.read_population({})['replacements'] == []
    assert len(calls) == 2


def test_timeout_retry_is_bounded(tmp_path, monkeypatch):
    runner = tmp_path / 'atomic.cjs'
    runner.write_text('// fixture')
    monkeypatch.setenv('ATOMIC_POPULATION_RUNNER', str(runner))
    calls = []
    def run(*args, **kwargs):
        calls.append(1)
        raise runtime.subprocess.TimeoutExpired(args[0], 1800)
    monkeypatch.setattr(runtime.subprocess, 'run', run)
    with pytest.raises(runtime.subprocess.TimeoutExpired):
        runtime.read_population({})
    assert len(calls) == 2


def test_retry_shares_remaining_wall_budget_and_reserves_persistence(tmp_path,monkeypatch):
    runner=tmp_path/'runner.cjs';runner.write_text('// fixture')
    monkeypatch.setenv('ATOMIC_POPULATION_RUNNER',str(runner))
    clock=[1000.0]
    monkeypatch.setattr(runtime,'time',SimpleNamespace(monotonic=lambda:clock[0]))
    timeouts=[]
    def run(command,**kwargs):
        timeouts.append(kwargs['timeout'])
        if len(timeouts)==1:
            clock[0]+=1800
            raise runtime.subprocess.TimeoutExpired(command,1800)
        kwargs['stdout'].write(b'{"schema_version":"atomic-canonical-population-v1","replacements":[]}')
        return SimpleNamespace(returncode=0,stderr=b'')
    monkeypatch.setattr(runtime.subprocess,'run',run)
    runtime.read_population({})
    assert timeouts==[1800,1740]


def test_restore_cannot_consume_node_budget_then_reset_watchdog(tmp_path,monkeypatch):
    from services import atomic_replay_checkpoints as checkpoints
    runner=tmp_path/'runner.cjs';runner.write_text('// fixture')
    monkeypatch.setenv('ATOMIC_POPULATION_RUNNER',str(runner))
    clock=[1000.0]
    monkeypatch.setattr(runtime,'time',SimpleNamespace(monotonic=lambda:clock[0]))
    def enter(store):clock[0]+=3541;return store
    monkeypatch.setattr(checkpoints.AtomicReplayCheckpoints,'__enter__',enter)
    monkeypatch.setattr(runtime.subprocess,'run',lambda *a,**kw:pytest.fail('no remaining child budget'))
    with pytest.raises(checkpoints.AtomicReplayDeadlineExceeded,match='before_node'):
        runtime.read_population({})
