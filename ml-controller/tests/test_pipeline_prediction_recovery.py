from copy import deepcopy
import importlib.util
from pathlib import Path
import pytest
from services.pipeline_prediction_recovery import register_request, recover_request, registry_key, digest, PREFIX

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


def registry(ref):
    return registry_key(ref['run_date'], ref['run_id'])


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


def _driver(ref, stage_store, now, calls):
    def driver():
        journal = stages.Journal(stage_store, ref, clock=lambda: now[0])
        with journal.driver():
            cpu = journal.cpu('formal', 'feature', lambda: calls.append('cpu') or [1.,2.])
            return cpu, journal.gpu({'series': ['2330']})
    return driver


def test_watchdog_resumes_after_lost_gpu_ack_with_exact_input_and_no_repeated_cpu():
    ref, store, now, queue, recover = fixture()
    stage_store = StageStore(store)
    calls = []
    driver = _driver(ref, stage_store, now, calls)
    with pytest.raises(stages.Suspended) as waiting: driver()
    first = waiting.value.dispatch  # The spawn acknowledgement is lost: no receipt.
    now[0] = 300
    assert recover()['reason'] == 'gpu_dispatch_grace'
    assert not queue
    now[0] = 601
    assert recover()['reason'] == 'same_request_resumed'
    assert stages.reference_identity(queue[0]) == stages.reference_identity(ref)
    assert queue[0]['callback_token'] == 'current-private'
    with pytest.raises(stages.Suspended) as retry: driver()
    assert calls == ['cpu'] and retry.value.dispatch == first  # Same request, re-sent.
    def lost_ack(_): raise OSError('fixture')
    with pytest.raises(OSError):
        stages.run_gpu_stage(stage_store, first, predict=lambda _: [3.,4.],
            resume=lost_ack, clock=lambda:now[0])
    assert stages.run_gpu_stage(stage_store, retry.value.dispatch, predict=lambda _: pytest.fail('twice'),
        resume=queue.append, clock=lambda:now[0])['status'] == 'resumed'
    now[0] += 601
    assert recover()['reason'] == 'same_request_resumed'
    assert driver() == ([1.,2.], [3.,4.])
    assert calls == ['cpu']
    assert 'private' not in str(store.rows)


def test_a_queued_gpu_request_is_left_alone_until_the_limit_then_the_driver_closes_the_run():
    ref, store, now, queue, recover = fixture()
    stage_store = StageStore(store)
    driver = _driver(ref, stage_store, now, [])
    with pytest.raises(stages.Suspended) as waiting: driver()
    stages.Journal(stage_store, ref, clock=lambda: now[0]).dispatched(waiting.value.dispatch, 'fc-gpu')
    for tick in range(1200, 14400, 1200):
        now[0] = tick
        out = recover()
        assert out == {'reason': 'gpu_queued', 'gpu_queued_s': tick, 'gpu_queue_remaining_s': 14400 - tick}
    assert not queue and store.read(registry(ref) + '/dispatch')[0] is None
    now[0] = 14400
    out = recover()
    assert out['reason'] == 'same_request_resumed' and out['attempt'] == 1
    assert out['gpu_queue_exhausted'] is True and out['gpu_queued_s'] == 14400
    with pytest.raises(stages.GpuStageUnavailable, match='queue_exhausted'): driver()


def test_a_started_gpu_lease_runs_from_execution_and_counts_no_queue_time():
    ref, store, now, queue, recover = fixture()
    stage_store = StageStore(store)
    driver = _driver(ref, stage_store, now, [])
    with pytest.raises(stages.Suspended) as waiting: driver()
    stages.Journal(stage_store, ref, clock=lambda: now[0]).dispatched(waiting.value.dispatch, 'fc-gpu')
    def killed(_): raise SystemExit('container killed')
    with pytest.raises(SystemExit):
        stages.run_gpu_stage(stage_store, waiting.value.dispatch, predict=killed, resume=pytest.fail,
                             clock=lambda: 7600)
    now[0] = 7600 + 1049
    assert recover() == {'reason': 'gpu_lease_active'}
    now[0] = 7600 + 1050
    out = recover()
    assert out['reason'] == 'same_request_resumed' and 'gpu_queue_exhausted' not in out


def test_an_abandoned_claim_still_gets_a_driver_to_close_the_run_and_deploys_keep_the_note():
    ref, store, now, queue, recover = fixture()
    stage_store = StageStore(store)
    driver = _driver(ref, stage_store, now, [])
    with pytest.raises(stages.Suspended) as waiting: driver()
    journal = stages.Journal(stage_store, ref, clock=lambda: now[0])
    journal.dispatched(waiting.value.dispatch, 'fc-gpu')
    now[0] = 14400
    assert recover(source_sha='c'*40) == {'reason': 'source_changed', 'recovery_blocked': True,
                                          'gpu_queue_exhausted': True, 'gpu_queued_s': 14400}
    with pytest.raises(stages.GpuStageUnavailable): driver()  # The driver abandoned the claim.
    out = recover()
    assert out['reason'] == 'same_request_resumed' and 'gpu_queue_exhausted' not in out and len(queue) == 1


def test_recovery_exhaustion_fences_a_queued_gpu_request_from_running_later():
    ref, store, now, queue, recover = fixture()
    stage_store = StageStore(store)
    driver = _driver(ref, stage_store, now, [])
    with pytest.raises(stages.Suspended) as waiting: driver()  # Every spawn ack is lost.
    for attempt in (1, 2, 3):
        now[0] += 601
        assert recover()['attempt'] == attempt
    now[0] += 601
    assert recover()['error'] == 'pipeline_modal_recovery_attempts_exhausted'
    assert stages.run_gpu_stage(stage_store, waiting.value.dispatch, predict=lambda _: pytest.fail('ran'),
        resume=lambda _: pytest.fail('resumed'), clock=lambda: now[0]) == {'status': 'abandoned'}


def test_claims_written_before_the_queue_split_keep_the_old_lease_rule():
    ref, store, now, queue, recover = fixture()
    stage_store = StageStore(store)
    journal = stages.Journal(stage_store, ref, clock=lambda: now[0])
    gpu = journal.root + '/gpu/' + 'c'*64
    journal.progress({'gpu': gpu, 'token': 'd'*32})
    stage_store.put(gpu + '/claim', {'token': 'd'*32, 'until': 1050, 'attempt': 1})
    now[0] = 1049
    assert recover() == {'reason': 'gpu_lease_active'}
    now[0] = 1050
    assert recover()['reason'] == 'same_request_resumed'


def test_gpu_queue_ops_lines_are_warn_while_queued_error_at_the_limit_and_never_fail():
    import logging
    from services.pipeline_prediction_recovery import GPU_QUEUE_LOG_CRON, write_gpu_queue_log
    rows, log = [], logging.getLogger('fixture')
    kw = dict(run_date='2026-10-29', run_id='exact-run', logger=log)
    def execute(sql, params):
        assert 'INSERT INTO system_logs' in sql
        rows.append(params)
    assert write_gpu_queue_log({'reason': 'gpu_queued', 'gpu_queued_s': 3600., 'gpu_queue_remaining_s': 10800.},
                               ops_execute=execute, **kw) == 'warn'
    assert write_gpu_queue_log({'reason': 'same_request_resumed', 'attempt': 1, 'gpu_queue_exhausted': True,
                                'gpu_queued_s': 14400.}, ops_execute=execute, **kw) == 'error'
    assert write_gpu_queue_log({'reason': 'gpu_lease_active'}, ops_execute=execute, **kw) is None
    assert [r[:2] for r in rows] == [['warn', GPU_QUEUE_LOG_CRON], ['error', GPU_QUEUE_LOG_CRON]]
    assert 'queue_exhausted' in rows[1][2] and '"gpu_queued_s": 14400.0' in rows[1][3]
    assert 'token' not in str(rows)
    def down(*_): raise OSError('d1 down')
    assert write_gpu_queue_log({'reason': 'gpu_queued', 'gpu_queued_s': 1., 'gpu_queue_remaining_s': 2.},
                               ops_execute=down, **kw) == 'warn'


def test_reconcile_hook_writes_the_gpu_queue_line_to_ops(monkeypatch):
    from services import d1_domain_client
    from services.pipeline_prediction_recovery import log_gpu_queue
    rows = []
    class Ops:
        def execute(self, sql, params): rows.append(params)
    monkeypatch.setattr(d1_domain_client, 'client_proxy_for_domain', lambda domain: Ops())
    kw = dict(run_date='2026-10-29', run_id='exact-run')
    assert log_gpu_queue({'reason': 'gpu_queued', 'gpu_queued_s': 60., 'gpu_queue_remaining_s': 5.}, **kw) == 'warn'
    assert rows and rows[0][0] == 'warn'
    assert log_gpu_queue({'reason': 'gpu_lease_active'}, **kw) is None and len(rows) == 1
    route = (Path(__file__).resolve().parents[1] / 'routers/pipeline.py').read_text()
    assert 'await asyncio.to_thread(log_gpu_queue, recovery, run_date=date, run_id=run_id)' in route


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
