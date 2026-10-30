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
        assert out == {'reason': 'gpu_queued', 'gpu_role': 'formal', 'gpu_queued_s': tick,
                       'gpu_queue_remaining_s': 14400 - tick, 'gpu_log': 'gpu_queued'}
    assert not queue and store.read(registry(ref) + '/dispatch')[0] is None
    now[0] = 14400
    out = recover()
    assert out['reason'] == 'same_request_resumed' and out['attempt'] == 1
    assert out['gpu_queue_exhausted'] is True and out['gpu_queued_s'] == 14400
    assert out['gpu_log'] == 'gpu_queue_exhausted'
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
    blocked = {'reason': 'source_changed', 'recovery_blocked': True, 'gpu_queue_exhausted': True,
               'gpu_role': 'formal', 'gpu_queued_s': 14400}
    assert recover(source_sha='c'*40) == {**blocked, 'gpu_log': 'gpu_queue_limit_blocked'}
    claim_key = PREFIX + journal.root + '/gpu/' + waiting.value.dispatch['stage'] + '/claim'
    assert store.read(claim_key)[0]['abandoned'] is True  # A late GPU request cannot run.
    now[0] = 15600
    assert recover(source_sha='c'*40) == {'reason': 'source_changed', 'recovery_blocked': True}  # Once.
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


def test_gpu_queue_ops_lines_by_reason_never_fail_the_reconcile():
    import logging
    from services.pipeline_prediction_recovery import GPU_QUEUE_LOG_CRON, write_gpu_queue_log
    rows, log = [], logging.getLogger('fixture')
    kw = dict(run_date='2026-10-29', run_id='exact-run', logger=log)
    def execute(sql, params):
        assert 'INSERT INTO system_logs' in sql
        rows.append(params)
    cases = [
        ({'reason': 'gpu_queued', 'gpu_role': 'formal', 'gpu_queued_s': 3600., 'gpu_queue_remaining_s': 10800.,
          'gpu_log': 'gpu_queued'}, 'warn', 'left before the run fails'),
        ({'reason': 'same_request_resumed', 'attempt': 1, 'gpu_queue_exhausted': True, 'gpu_role': 'formal',
          'gpu_queued_s': 14400., 'gpu_log': 'gpu_queue_exhausted'}, 'error', 'pipeline_stage_gpu_queue_exhausted'),
        ({'reason': 'gpu_queued', 'gpu_role': 'shadow', 'gpu_queued_s': 60., 'gpu_queue_remaining_s': 3540.,
          'gpu_log': 'gpu_shadow_queued'}, 'warn', 'no production effect'),
        ({'reason': 'same_request_resumed', 'gpu_queue_exhausted': True, 'gpu_role': 'shadow',
          'gpu_queued_s': 3600., 'gpu_log': 'gpu_shadow_queue_skipped'}, 'warn', 'formal results are unaffected'),
        ({'reason': 'source_changed', 'recovery_blocked': True, 'gpu_queue_exhausted': True, 'gpu_role': 'formal',
          'gpu_queued_s': 14400., 'gpu_log': 'gpu_queue_limit_blocked'}, 'error', 'recovery is blocked'),
    ]
    for recovery, level, text in cases:
        assert write_gpu_queue_log(recovery, ops_execute=execute, **kw) == level
        assert rows[-1][:2] == [level, GPU_QUEUE_LOG_CRON] and text in rows[-1][2]
    assert '"gpu_queued_s": 14400.0' in rows[1][3] and '"gpu_role": "shadow"' in rows[3][3]
    assert write_gpu_queue_log({'reason': 'gpu_queued'}, ops_execute=execute, **kw) is None  # Not named.
    assert len(rows) == 5 and 'token' not in str(rows)
    def down(*_): raise OSError('d1 down')
    assert write_gpu_queue_log(cases[0][0], ops_execute=down, **kw) == 'warn'


def test_reconcile_hook_writes_the_gpu_queue_line_to_ops(monkeypatch):
    from services import d1_domain_client
    from services.pipeline_prediction_recovery import log_gpu_queue
    rows = []
    class Ops:
        def execute(self, sql, params): rows.append(params)
    monkeypatch.setattr(d1_domain_client, 'client_proxy_for_domain', lambda domain: Ops())
    kw = dict(run_date='2026-10-29', run_id='exact-run')
    assert log_gpu_queue({'reason': 'gpu_queued', 'gpu_queued_s': 60., 'gpu_queue_remaining_s': 5.,
                          'gpu_log': 'gpu_queued'}, **kw) == 'warn'
    assert rows and rows[0][0] == 'warn'
    assert log_gpu_queue({'reason': 'gpu_lease_active'}, **kw) is None and len(rows) == 1
    route = (Path(__file__).resolve().parents[1] / 'routers/pipeline.py').read_text()
    assert 'await asyncio.to_thread(log_gpu_queue, recovery, run_date=date, run_id=run_id)' in route


def _shadow_driver(ref, stage_store, now):
    def driver():
        journal = stages.Journal(stage_store, ref, clock=lambda: now[0])
        with journal.driver():
            formal = journal.cpu('formal', 'feature', lambda: [1.])
            try:
                shadow = journal.gpu({'series': ['shadow']}, shadow=True)
            except stages.GpuStageUnavailable as exc:
                shadow = str(exc)
            return formal, shadow
    return driver


def test_a_shadow_gpu_queue_logs_once_and_is_skipped_at_its_limit_without_failing_the_run():
    ref, store, now, queue, recover = fixture()
    stage_store = StageStore(store)
    driver = _shadow_driver(ref, stage_store, now)
    with pytest.raises(stages.Suspended) as waiting: driver()
    stages.Journal(stage_store, ref, clock=lambda: now[0]).dispatched(waiting.value.dispatch, 'fc-shadow')
    now[0] = 1200
    assert recover()['gpu_log'] == 'gpu_shadow_queued'
    now[0] = 2400
    out = recover()
    assert out['reason'] == 'gpu_queued' and out['gpu_role'] == 'shadow' and 'gpu_log' not in out
    now[0] = 3600
    out = recover()
    assert out['reason'] == 'same_request_resumed' and out['gpu_log'] == 'gpu_shadow_queue_skipped'
    assert driver() == ([1.], 'pipeline_stage_gpu_shadow_queue_exhausted')


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


def _queued_gpu(ref, store, now, dispatch_id='fc-gpu', shadow=False):
    stage_store = StageStore(store)
    journal = stages.Journal(stage_store, ref, clock=lambda: now[0])
    with pytest.raises(stages.Suspended) as waiting:
        with journal.driver():
            journal.gpu({'series': ['2330']}, shadow=shadow)
    if dispatch_id:
        journal.dispatched(waiting.value.dispatch, dispatch_id)
    return stage_store, journal, waiting.value.dispatch


def test_recovery_exhaustion_yields_to_a_container_that_started_during_the_fence():
    ref, store, now, queue, recover = fixture()
    stage_store, journal, dispatch = _queued_gpu(ref, store, now, dispatch_id=None)
    for attempt in (1, 2, 3):
        now[0] += 601
        assert recover()['attempt'] == attempt
    real_cas = store.cas
    def racing(key, value, generation):
        if key.endswith('/claim') and value.get('abandoned'):
            with pytest.raises(SystemExit):
                stages.run_gpu_stage(stage_store, dispatch, predict=lambda _: (_ for _ in ()).throw(SystemExit()),
                                     resume=pytest.fail, clock=lambda: now[0])
        return real_cas(key, value, generation)
    store.cas = racing
    now[0] += 601
    assert recover() == {'reason': 'gpu_lease_active'}


def test_an_older_tokens_result_gets_a_driver_even_while_a_newer_token_queues():
    ref, store, now, queue, recover = fixture()
    stage_store, journal, first = _queued_gpu(ref, store, now)
    with pytest.raises(SystemExit):
        stages.run_gpu_stage(stage_store, first, predict=lambda _: (_ for _ in ()).throw(SystemExit()),
                             resume=pytest.fail, clock=lambda: 700)
    now[0] = 700 + stages.GPU_LEASE_SECONDS
    _, _, second = _queued_gpu(ref, store, now, dispatch_id='fc-2')
    assert second['token'] != first['token']
    now[0] += 1200
    out = recover()
    assert out['reason'] == 'gpu_queued' and out['gpu_queued_s'] == 700 + 1200  # Queue time over tokens.
    stage_store.put(journal.root + '/gpu/' + first['stage'] + '/result/' + first['token'],
                    {'input_checksum': first['stage'], 'value': {'late': 1}})
    assert recover()['reason'] == 'same_request_resumed'


def test_the_once_marker_survives_a_landed_conflict_and_never_fails_the_reconcile():
    ref, store, now, queue, recover = fixture()
    _queued_gpu(ref, store, now, shadow=True)
    now[0] = 1200
    real_cas = store.cas
    def ghost(key, value, generation):
        ok = real_cas(key, value, generation)
        return False if ok and '/ops-log/' in key else ok
    store.cas = ghost
    assert recover()['gpu_log'] == 'gpu_shadow_queued'
    def broken(key, value, generation):
        if '/ops-log/' in key:
            raise OSError('gcs 503')
        return real_cas(key, value, generation)
    store.cas = broken
    now[0] = 3600
    out = recover()
    assert out['reason'] == 'same_request_resumed' and 'gpu_log' not in out


def test_an_uncertain_dispatch_at_the_limit_still_names_the_ops_line():
    ref, store, now, queue, recover = fixture()
    _queued_gpu(ref, store, now)
    now[0] = 14400
    def lost(_): raise OSError('ack lost')
    out = recover(spawn=lost)
    assert out['reason'] == 'recovery_dispatch_uncertain' and out['gpu_log'] == 'gpu_queue_exhausted'


def test_shadow_lines_are_once_per_run_not_once_overall():
    base, store, now, queue, recover = fixture()  # One store: the marker must be keyed by run.
    logged = []
    for run_id in ('run-a', 'run-b'):
        ref = {**base, 'run_id': run_id}
        register_request(ref, store=store, clock=lambda: 0)
        now[0] = 0
        _queued_gpu(ref, store, now, shadow=True)
        now[0] = 1200
        logged.append(recover(run_id=run_id).get('gpu_log'))
        now[0] = 2400
        assert 'gpu_log' not in recover(run_id=run_id)
    assert logged == ['gpu_shadow_queued', 'gpu_shadow_queued']
