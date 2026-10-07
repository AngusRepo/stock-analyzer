from copy import deepcopy
import importlib.util
from pathlib import Path
import pytest
from services.pipeline_prediction_recovery import register_request, recover_request, digest, PREFIX

spec = importlib.util.spec_from_file_location('modal_stage_contract',
    Path(__file__).resolve().parents[2] / 'ml-service/app/pipeline_prediction_stages.py')
stages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stages)


class Store:
    def __init__(self):
        self.rows = {}
        self.serial = 0
    def read(self, key):
        return deepcopy(self.rows.get(key, (None, 0)))
    def generation(self, key):
        return self.read(key)[1]
    def cas(self, key, value, generation):
        if self.generation(key) != generation:
            return False
        self.serial += 1
        self.rows[key] = (deepcopy(value), self.serial)
        return True
    def put(self, key, value):
        self.cas(key, value, 0)
        return self.read(key)[0]


class StageStore:
    def __init__(self, store): self.store = store
    def read(self, key): return self.store.read(PREFIX + key)
    def cas(self, key, value, generation): return self.store.cas(PREFIX + key, value, generation)
    def put(self, key, value): return self.store.put(PREFIX + key, value)


def fixture():
    reference = {'schema_version': stages.REF_SCHEMA, 'run_date': '2026-09-29',
        'run_id': 'exact-run', 'expected_source_sha': 'a'*40, 'request_generation': '7',
        'request_sha256': 'b'*64, 'request_gcs_uri': 'gs://fixture/immutable.json.gz',
        'callback_token': 'old-private', 'callback_url': 'https://old/callback'}
    store, now, queue = Store(), [0.], []
    register_request(reference, store=store, clock=lambda: now[0])
    def recover(**overrides):
        args = dict(run_date=reference['run_date'], run_id=reference['run_id'],
            callback_url='https://current/callback', callback_token='current-private',
            source_sha='a'*40, spawn=lambda ref: queue.append(ref) or {'function_call_id':'fc-1'},
            store=store, clock=lambda: now[0])
        return recover_request(**(args | overrides))
    return reference, store, now, queue, recover


def test_watchdog_resumes_after_lost_gpu_ack_with_exact_input_and_no_repeated_cpu():
    ref, store, now, queue, recover = fixture()
    stage_store = StageStore(store)
    calls = []
    def driver():
        journal = stages.Journal(stage_store, ref, clock=lambda: now[0])
        with journal.driver():
            cpu = journal.cpu('formal', 'feature', lambda: calls.append('cpu') or [1.,2.])
            return cpu, journal.gpu({'series': ['2330']})
    with pytest.raises(stages.Suspended) as waiting: driver()
    first = waiting.value.dispatch
    now[0] = 601
    assert recover()['reason'] == 'gpu_lease_active'
    assert not queue
    now[0] = 1051
    assert recover()['reason'] == 'same_request_resumed'
    assert stages.reference_identity(queue[0]) == stages.reference_identity(ref)
    assert queue[0]['callback_token'] == 'current-private'
    with pytest.raises(stages.Suspended) as retry: driver()
    assert calls == ['cpu'] and retry.value.dispatch['token'] != first['token']
    assert stages.run_gpu_stage(stage_store, first, predict=lambda _: pytest.fail('old attempt'),
        resume=queue.append, clock=lambda:now[0])['status'] == 'superseded'
    def lost_ack(_): raise OSError('fixture')
    with pytest.raises(OSError):
        stages.run_gpu_stage(stage_store, retry.value.dispatch, predict=lambda _: [3.,4.],
            resume=lost_ack, clock=lambda:now[0])
    now[0] += 601
    assert recover()['reason'] == 'same_request_resumed'
    assert driver() == ([1.,2.], [3.,4.])
    assert calls == ['cpu']
    assert 'private' not in str(store.rows)


def test_hard_killed_cpu_lease_and_bounded_recovery():
    ref, store, now, queue, recover = fixture()
    journal = stages.Journal(StageStore(store), ref, clock=lambda:now[0])
    store.put(PREFIX + journal.root + '/driver', {'token':'killed','until':3660})
    now[0] = 601
    assert recover()['reason'] == 'cpu_lease_active'
    now[0] = 3661
    assert recover()['attempt'] == 1
    assert recover()['reason'] == 'recovery_dispatch_grace'
    for attempt in (2,3):
        now[0] += 601
        assert recover()['attempt'] == attempt
    now[0] += 601
    assert recover()['error'] == 'pipeline_modal_recovery_attempts_exhausted'
    assert len(queue) == 3
    journal.progress({'cpu': journal.root + '/cpu/formal/feature'})
    assert recover()['attempt'] == 1


def test_identity_terminal_source_change_and_uncertain_spawn():
    ref, store, now, queue, recover = fixture()
    register_request(ref, store=store)
    with pytest.raises(ValueError, match='reference_conflict'):
        register_request(ref | {'request_generation':'8'}, store=store)
    now[0] = 601
    assert recover(source_sha='c'*40)['reason'] == 'source_changed'
    assert not queue
    def lost(_): raise OSError('token private')
    assert recover(spawn=lost)['reason'] == 'recovery_dispatch_uncertain'
    assert 'private' not in str(store.rows)
    root = PREFIX + stages.digest(stages.reference_identity(ref))
    store.put(root + '/terminal', {'status':'callback_accepted'})
    assert recover()['reason'] == 'callback_accepted'
    assert recover(run_id='other')['reason'] == 'no_registered_modal_request'


def test_digest_matches_modal():
    value = {'a': [1.23456789, None, '台股'], 'z': True}
    assert digest(value) == stages.digest(value)

def test_actual_controller_spawn_persists_reference_before_uncertain_rpc(monkeypatch):
    import ast
    from typing import Any
    from services import pipeline_prediction_recovery as recovery, modal_client
    source = Path(__file__).parents[1] / 'graphs/daily_pipeline_v2.py'
    fn = next(n for n in ast.parse(source.read_text(encoding='utf-8')).body
              if isinstance(n, ast.FunctionDef) and n.name == '_spawn_pipeline_prediction_bundle_from_artifact')
    ref, store, now, queue, recover = fixture()
    ref |= {'request_uncompressed_bytes':10, 'request_compressed_bytes':5}
    events = []
    monkeypatch.setattr(recovery, 'register_request', lambda payload: events.append(('registered',payload)))
    def spawn(payload):
        assert events == [('registered', payload)]
        events.append(('spawn',payload))
        raise OSError('ack lost')
    monkeypatch.setattr(modal_client, 'spawn_pipeline_prediction_bundle', spawn)
    ns = {'Any':Any, 'write_pipeline_modal_request_artifact':lambda _:ref}
    exec(compile(ast.Module(body=[fn],type_ignores=[]), str(source), 'exec'), ns)
    result = ns[fn.name]({})
    assert result['status'] == 'dispatch_uncertain'
    assert result['request_generation'] == '7'
    assert 'callback_token' not in result


def test_release_overlap_preserves_active_cpu_and_gpu_and_never_dispatches_wrong_source():
    ref, store, now, queue, recover = fixture()
    now[0] = 601
    journal = stages.Journal(StageStore(store), ref, clock=lambda: now[0])
    root = PREFIX + journal.root
    store.put(root + '/driver', {'token': 'active', 'until': 1000})
    assert recover(source_sha='c'*40) == {'reason': 'cpu_lease_active'}
    now[0] = 1001
    gpu = journal.root + '/gpu/fixture'
    store.put(root + '/progress', {'gpu': gpu})
    store.put(PREFIX + gpu + '/claim', {'token': 'gpu', 'until': 2000})
    assert recover(source_sha='c'*40) == {'reason': 'gpu_lease_active'}
    now[0] = 2001
    assert recover(source_sha='c'*40) == {'reason': 'source_changed', 'recovery_blocked': True}
    assert recover(source_sha='') == {'reason': 'source_changed', 'recovery_blocked': True}
    assert not queue
    store.put(root + '/terminal', {'status': 'callback_accepted'})
    assert recover(source_sha='c'*40) == {'reason': 'callback_accepted'}
