from copy import deepcopy
import pytest
from app.pipeline_prediction_stages import (GPU_LEASE_SECONDS, GpuStageUnavailable, Journal, Suspended,
    namespace, run_gpu_stage)


class Store:
    def __init__(self):
        self.rows = {}
        self.serial = 0
    def read(self, key):
        return deepcopy(self.rows.get(key, (None, 0)))
    def cas(self, key, value, generation):
        if self.rows.get(key, (None, 0))[1] != generation:
            return False
        self.serial += 1
        self.rows[key] = (deepcopy(value), self.serial)
        return True
    def put(self, key, value):
        self.cas(key, value, 0)
        return self.read(key)[0]


def reference():
    return {'schema_version': 'pipeline-modal-prediction-request-ref-v1',
        'request_sha256': 'a' * 64, 'request_generation': '3',
        'expected_source_sha': 'b' * 40, 'run_id': 'fixture',
        'callback_token': 'never-persist', 'callback_url': 'https://fixture/callback'}


def test_suspend_resume_preserves_cpu_results_and_does_not_wait_or_repeat_gpu():
    store, now, counts, queue = Store(), [100.], {'cpu': 0, 'gpu': 0}, []
    def cpu():
        counts['cpu'] += 1
        return {'results': [{'symbol': '2330', 'value': .123456789}]}
    def predict(payload):
        counts['gpu'] += 1
        return {'results': [{'symbol': payload['series'][0], 'value': .3}]}
    def driver():
        journal = Journal(store, reference(), clock=lambda: now[0])
        with journal.driver():
            first = journal.cpu('inputs', 'cpu', cpu)
            second = journal.gpu({'series': ['2330']})
            return [first, second]
    with pytest.raises(Suspended) as pending:
        driver()
    dispatch = pending.value.dispatch
    assert counts == {'cpu': 1, 'gpu': 0}  # CPU returned before any GPU work.
    with pytest.raises(Suspended) as duplicate:
        driver()
    assert duplicate.value.dispatch is None
    now[0] += 125
    assert run_gpu_stage(store, dispatch, predict=predict, resume=queue.append,
                         clock=lambda: now[0])['status'] == 'resumed'
    result = driver()
    assert result == [cpu(), {'results': [{'symbol': '2330', 'value': .3}]}]
    assert counts == {'cpu': 2, 'gpu': 1}  # second CPU call is baseline comparison only.
    run_gpu_stage(store, dispatch, predict=predict, resume=queue.append, clock=lambda: now[0])
    assert counts['gpu'] == 1 and len(queue) == 2
    assert 'never-persist' not in str(store.rows)
    assert Journal(store, reference(), clock=lambda: now[0]).elapsed() == 125


def test_lost_dispatch_ack_resends_the_same_token_bounded_and_runs_once():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as first:
        journal.gpu({'x': 1})
    with pytest.raises(Suspended) as wait:
        journal.gpu({'x': 1})
    assert wait.value.dispatch is None  # Inside the receipt grace.
    resent = []
    for _ in range(4):
        now[0] += 601
        with pytest.raises(Suspended) as again:
            journal.gpu({'x': 1})
        resent.append(again.value.dispatch)
    assert [d and d['token'] for d in resent] == [first.value.dispatch['token']] * 2 + [None, None]
    calls = []
    assert run_gpu_stage(store, first.value.dispatch, predict=lambda p: calls.append(p) or {'result': 2},
                         resume=calls.append, clock=lambda: now[0])['status'] == 'resumed'
    assert run_gpu_stage(store, resent[0], predict=lambda _: pytest.fail('twice'),
                         resume=calls.append, clock=lambda: now[0])['status'] == 'resumed'
    assert journal.gpu({'x': 1}) == {'result': 2} and calls[0] == {'x': 1} and len(calls) == 3


def test_a_receipt_stops_resends_and_only_executions_count_as_attempts():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    tokens = []
    for attempt in range(1, 4):
        with pytest.raises(Suspended) as pending:
            journal.gpu({'x': 2})
        dispatch = pending.value.dispatch
        journal.dispatched(dispatch, 'fc-%d' % attempt)
        tokens.append(dispatch['token'])
        now[0] += 3000  # Queued long past the lease: still the same request.
        with pytest.raises(Suspended) as queued:
            journal.gpu({'x': 2})
        assert queued.value.dispatch is None
        def crash(_):
            raise SystemExit('container killed')
        with pytest.raises(SystemExit):
            run_gpu_stage(store, dispatch, predict=crash, resume=pytest.fail, clock=lambda: now[0])
        claim = store.read(journal.root + '/gpu/' + dispatch['stage'] + '/claim')[0]
        assert claim['attempt'] == attempt and claim['until'] == now[0] + GPU_LEASE_SECONDS
        now[0] += GPU_LEASE_SECONDS - 1
        with pytest.raises(Suspended) as running:
            journal.gpu({'x': 2})
        assert running.value.dispatch is None
        now[0] += 1
    assert len(set(tokens)) == 3
    with pytest.raises(GpuStageUnavailable, match='attempts_exhausted'):
        journal.gpu({'x': 2})


def test_failure_receipt_and_lost_continuation_are_recoverable_without_recompute():
    store, queued = Store(), []
    journal = Journal(store, reference(), clock=lambda: 0)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    def fail(_):
        raise ValueError('credential must never reach a receipt')
    def lost_ack(_):
        raise OSError('continuation acknowledgement lost')
    with pytest.raises(OSError):
        run_gpu_stage(store, pending.value.dispatch, predict=fail, resume=lost_ack, clock=lambda: 0)
    run_gpu_stage(store, pending.value.dispatch, predict=lambda _: pytest.fail('recomputed'),
                  resume=queued.append, clock=lambda: 0)
    with pytest.raises(RuntimeError, match='gpu_failed:ValueError'):
        journal.gpu({'x': 1})
    assert len(queued) == 1 and 'credential' not in str(store.rows)


def test_tamper_generation_and_driver_interruption():
    store = Store()
    journal = Journal(store, reference(), clock=lambda: 0)
    with journal.driver():
        with pytest.raises(Suspended):
            with Journal(store, reference(), clock=lambda: 0).driver():
                pytest.fail('concurrent driver admitted')
        with pytest.raises(Suspended) as pending:
            journal.gpu({'x': 1})
    with journal.driver():
        pass
    packet = pending.value.dispatch
    key = journal.root + '/gpu/' + packet['stage'] + '/input'
    store.rows[key][0]['value']['x'] = 2
    assert run_gpu_stage(store, packet, predict=lambda _: pytest.fail('bad input'),
        resume=lambda _: None, clock=lambda: 0)['failed'] is True
    with pytest.raises(RuntimeError, match='gpu_failed:ValueError'):
        journal.gpu({'x': 1})
    altered = {**reference(), 'request_generation': '4'}
    assert Journal(store, altered).root != journal.root
    assert namespace({'rows': [1], 'model': 'v1'}) != namespace({'rows': [2], 'model': 'v1'})


def test_crashed_driver_recovers_only_after_hard_timeout_and_grace():
    store = Store()
    journal = Journal(store, reference(), clock=lambda: 0)
    store.put(journal.root + '/driver', {'token': 'dead', 'until': 3660})
    with pytest.raises(Suspended):
        with journal.driver():
            pass
    with Journal(store, reference(), clock=lambda: 3661).driver():
        pass


def test_actual_modal_entrypoints_suspend_resume_and_repeat_the_identical_publication(monkeypatch):
    import sys
    from types import SimpleNamespace
    import modal_app
    from app import pipeline_prediction_stages as stages
    from google.cloud import storage
    store, gpu_queue, resumes, publications, callbacks, cpu_calls = Store(), [], [], [], [], []
    original_cpu=modal_app.pipeline_prediction_bundle
    original_gpu=modal_app.timexer_universal_predict
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','b'*40)
    monkeypatch.setattr(modal_app,'_setup_env',lambda:None)
    monkeypatch.setattr(modal_app,'_get_gcs_bucket_name',lambda:'fixture')
    monkeypatch.setattr(storage,'Client',lambda:SimpleNamespace(bucket=lambda _:None))
    monkeypatch.setattr(stages,'GCSStore',lambda _:store)
    request=reference()
    hydrated={'run_id':'fixture','run_date':'2026-09-07','expected_source_sha':'b'*40}
    monkeypatch.setattr(modal_app,'_hydrate_pipeline_prediction_request_reference',lambda _:hydrated)
    def compute(payload):
        journal=stages.SCOPE.get()
        journal.cpu('inputs','features',lambda:cpu_calls.append(1) or {'features':[.2]})
        result=journal.gpu({'series_list':[{'symbol':'2330'}]})
        return {'n_input':1,'timexer_raw':result,'elapsed_s':1.}
    monkeypatch.setattr(modal_app,'_compute_pipeline_prediction_bundle',compute)
    def publish(payload,bundle):
        publications.append(deepcopy(bundle))
        return {'result_checksum':stages.digest(bundle),'result_gcs_uri':'gs://fixture/immutable'}
    monkeypatch.setattr(modal_app,'_persist_pipeline_prediction_bundle',publish)
    monkeypatch.setattr(modal_app,'_post_pipeline_prediction_callback',
        lambda payload,bundle,*_:callbacks.append(deepcopy(bundle['durable_handoff'])) or {'status':'ok'})
    monkeypatch.setattr(modal_app,'_post_pipeline_prediction_error_callback',lambda *_:pytest.fail('false terminal error'))
    monkeypatch.setattr(modal_app,'timexer_universal_predict',SimpleNamespace(spawn=gpu_queue.append))
    monkeypatch.setattr(modal_app,'pipeline_prediction_bundle',SimpleNamespace(spawn=resumes.append))
    monkeypatch.setitem(sys.modules,'app.timexer_inference',SimpleNamespace(batch_predict=lambda **kw:
        [{'symbol':kw['series_list'][0]['symbol'],'available':True,'prediction':.123456789}]))
    assert original_cpu.local(request)['status']=='waiting_gpu'
    assert len(gpu_queue)==1 and cpu_calls==[1] and not callbacks
    assert original_gpu.local(gpu_queue[0])['status']=='resumed'
    result=original_cpu.local(resumes[0])
    assert result['timexer_raw']['results'][0]['prediction']==.123456789
    assert result['callback_status']=={'status':'ok'}
    original_cpu.local(resumes[0])
    assert len(publications)==1 and cpu_calls==[1] and len(callbacks)==2
    assert callbacks[0]==callbacks[1]


def test_gcs_adapter_checks_checksum_and_generation_without_overwriting_first_result():
    import json
    from google.api_core.exceptions import NotFound, PreconditionFailed
    from app.pipeline_prediction_stages import GCSStore
    rows={}
    class Blob:
        def __init__(self,key):self.key=key;self.generation=None
        def reload(self):
            if self.key not in rows:raise NotFound('fixture')
            self.generation=rows[self.key][1]
        def download_as_bytes(self,*,if_generation_match):
            assert if_generation_match==self.generation
            return rows[self.key][0]
        def upload_from_string(self,raw,*,content_type,if_generation_match):
            old=rows.get(self.key,(None,0))
            if old[1]!=if_generation_match:raise PreconditionFailed('CAS conflict')
            rows[self.key]=(raw,old[1]+1)
    class Bucket:
        def blob(self,key):return Blob(key)
    store=GCSStore(Bucket())
    assert store.put('fixture',{'value':[.123456789]})=={'value':[.123456789]}
    assert store.put('fixture',{'value':['overwritten']})=={'value':[.123456789]}
    raw,generation=next(iter(rows.values()))
    key=next(iter(rows));packet=json.loads(raw);packet['value']['value']=[9]
    rows[key]=(json.dumps(packet).encode(),generation)
    with pytest.raises(ValueError,match='checksum_mismatch'):store.read('fixture')


def test_gpu_queued_past_its_lease_renews_it_and_runs_once():
    store,queue,runs=Store(),[],[]
    journal=Journal(store,reference(),clock=lambda:0)
    with pytest.raises(Suspended) as pending:journal.gpu({'x':1})
    dispatch=pending.value.dispatch
    def predict(payload):
        runs.append(payload)
        # While the renewed lease runs, a CPU resume waits instead of claiming again.
        with pytest.raises(Suspended) as waiting:Journal(store,reference(),clock=lambda:1100).gpu({'x':1})
        assert waiting.value.dispatch is None
        return {'y':2}
    assert run_gpu_stage(store,dispatch,predict=predict,resume=queue.append,clock=lambda:1051)['status']=='resumed'
    assert runs==[{'x':1}] and queue==[reference()]
    assert Journal(store,reference(),clock=lambda:5000).gpu({'x':1})=={'y':2}
    # A redelivered container for the same token never runs the GPU twice.
    run_gpu_stage(store,dispatch,predict=lambda _:pytest.fail('twice'),resume=queue.append,clock=lambda:5000)
    assert len(runs)==1


def test_newer_cpu_attempt_supersedes_an_expired_gpu_container():
    store=Store()
    with pytest.raises(Suspended) as first:Journal(store,reference(),clock=lambda:0).gpu({'x':1})
    with pytest.raises(SystemExit):
        run_gpu_stage(store,first.value.dispatch,predict=lambda _:(_ for _ in ()).throw(SystemExit()),
            resume=pytest.fail,clock=lambda:10)
    with pytest.raises(Suspended) as second:Journal(store,reference(),clock=lambda:10+GPU_LEASE_SECONDS).gpu({'x':1})
    assert second.value.dispatch['token']!=first.value.dispatch['token']
    assert run_gpu_stage(store,first.value.dispatch,predict=lambda _:pytest.fail('stale'),
        resume=lambda _:pytest.fail('stale'),clock=lambda:2000)=={'status':'superseded'}

def test_actual_cpu_entrypoint_does_not_send_terminal_error_for_lost_gpu_ack(monkeypatch):
    from types import SimpleNamespace
    from google.cloud import storage
    import modal_app
    from app import pipeline_prediction_stages as stages
    store = Store()
    monkeypatch.setattr(modal_app, '_setup_env', lambda:None)
    monkeypatch.setattr(modal_app, '_get_gcs_bucket_name', lambda:'fixture')
    monkeypatch.setattr(storage, 'Client', lambda:SimpleNamespace(bucket=lambda _:None))
    monkeypatch.setattr(stages, 'GCSStore', lambda _:store)
    monkeypatch.setattr(modal_app, '_hydrate_pipeline_prediction_request_reference', lambda ref:ref)
    def compute(_): return stages.SCOPE.get().gpu({'x':1})
    def lost(_): raise OSError('ack lost')
    monkeypatch.setattr(modal_app, '_pipeline_prediction_bundle_impl', compute)
    monkeypatch.setattr(modal_app, 'timexer_universal_predict', SimpleNamespace(spawn=lost))
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_error_callback',
        lambda *_:pytest.fail('uncertain dispatch is not terminal failure'))
    assert modal_app.pipeline_prediction_bundle.local(reference())['status']=='waiting_gpu'
    assert any('/gpu/' in key and key.endswith('/claim') for key in store.rows)


def _claim(store, journal, dispatch):
    return store.read(journal.root + '/gpu/' + dispatch['stage'] + '/claim')[0]


def test_1029_replay_a_two_hour_gpu_queue_reuses_one_request_and_delivers():
    # 10/29: spawn 00:48, watchdog resumes every ~20 min, L4 granted 2h07m later.
    store, now, spawned, resumed = Store(), [0.], [], []
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    spawned.append(pending.value.dispatch)
    journal.dispatched(pending.value.dispatch, 'fc-1')
    for tick in (1380, 2580, 3780, 4980, 6180, 7380):
        now[0] = tick
        with pytest.raises(Suspended) as waiting:
            Journal(store, reference(), clock=lambda: now[0]).gpu({'x': 1})
        assert waiting.value.dispatch is None
    claim = _claim(store, journal, spawned[0])
    assert claim['attempt'] == 0 and claim['tokens'] == [spawned[0]['token']] and 'started' not in claim
    now[0] = 7661
    assert run_gpu_stage(store, spawned[0], predict=lambda p: {'rows': [p['x']]},
                         resume=resumed.append, clock=lambda: now[0])['status'] == 'resumed'
    now[0] = 7840
    assert Journal(store, reference(), clock=lambda: now[0]).gpu({'x': 1}) == {'rows': [1]}
    assert len(spawned) == 1 and resumed == [reference()]


def test_queue_limit_abandons_cancels_and_never_seals_the_stage(monkeypatch):
    monkeypatch.setenv('PIPELINE_GPU_QUEUE_MAX_SECONDS', '7200')
    store, now, cancelled = Store(), [0.], []
    journal = Journal(store, reference(), clock=lambda: now[0], cancel=cancelled.append)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    dispatch = pending.value.dispatch
    journal.dispatched(dispatch, 'fc-1')
    now[0] = 7199
    with pytest.raises(Suspended):
        journal.gpu({'x': 1})
    now[0] = 7200
    def stage():
        try:
            return journal.gpu({'x': 1})
        except GpuStageUnavailable as exc:
            return {'error': str(exc), 'results': []}
    assert journal.cpu('ns', 'timexer', stage) == {'error': 'pipeline_stage_gpu_queue_exhausted', 'results': []}
    assert cancelled == ['fc-1'] and _claim(store, journal, dispatch)['abandoned'] is True
    assert not any('/cpu/' in key for key in store.rows)
    # The run is not revived: a late container does not run, and a resume fails the same way.
    assert run_gpu_stage(store, dispatch, predict=lambda _: pytest.fail('ran after abandon'),
                         resume=lambda _: pytest.fail('resumed'), clock=lambda: 9000) == {'status': 'abandoned'}
    with pytest.raises(GpuStageUnavailable, match='queue_exhausted'):
        journal.gpu({'x': 1})
    assert cancelled == ['fc-1']


def test_a_failed_cancel_does_not_change_the_outcome():
    store, now = Store(), [0.]
    def cancel(_):
        raise OSError('modal down')
    journal = Journal(store, reference(), clock=lambda: now[0], cancel=cancel)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    journal.dispatched(pending.value.dispatch, 'fc-1')
    now[0] = 4 * 3600
    with pytest.raises(GpuStageUnavailable, match='queue_exhausted'):
        journal.gpu({'x': 1})


def test_a_container_that_starts_first_wins_the_race_with_abandon():
    class Racing(Store):
        dispatch = None
        def cas(self, key, value, generation):
            if value.get('abandoned') and self.dispatch is not None:
                dispatch, self.dispatch = self.dispatch, None
                run_gpu_stage(self, dispatch, predict=lambda _: {'won': True}, resume=lambda _: None,
                              clock=lambda: 4 * 3600)
            return super().cas(key, value, generation)
    store = Racing()
    journal = Journal(store, reference(), clock=lambda: 4 * 3600)
    with pytest.raises(Suspended) as pending:
        Journal(store, reference(), clock=lambda: 0).gpu({'x': 1})
    store.dispatch = pending.value.dispatch
    assert journal.gpu({'x': 1}) == {'won': True}
    assert 'abandoned' not in _claim(store, journal, pending.value.dispatch)


def test_a_late_valid_result_of_an_older_token_is_used_while_a_newer_one_queues():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as first:
        journal.gpu({'x': 1})
    def held(_):
        raise SystemExit('lease lapses while still running')
    with pytest.raises(SystemExit):
        run_gpu_stage(store, first.value.dispatch, predict=held, resume=pytest.fail, clock=lambda: 10)
    now[0] = 10 + GPU_LEASE_SECONDS
    with pytest.raises(Suspended) as second:
        journal.gpu({'x': 1})
    journal.dispatched(second.value.dispatch, 'fc-2')
    # The first container's result lands after the second token was issued.
    key = journal.root + '/gpu/' + first.value.dispatch['stage'] + '/result/' + first.value.dispatch['token']
    store.put(key, {'input_checksum': first.value.dispatch['stage'], 'value': {'late': True}})
    # Used at once, while the second request still waits; no abandon needed.
    now[0] += 60
    assert journal.gpu({'x': 1}) == {'late': True}
    assert 'abandoned' not in _claim(store, journal, second.value.dispatch)


def test_a_terminal_run_never_starts_the_gpu():
    store = Store()
    journal = Journal(store, reference(), clock=lambda: 0)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    store.put(journal.root + '/terminal', {'status': 'error_callback_accepted'})
    assert run_gpu_stage(store, pending.value.dispatch, predict=lambda _: pytest.fail('ran'),
                         resume=lambda _: pytest.fail('resumed'), clock=lambda: 9) == {'status': 'terminal'}
    assert 'started' not in _claim(store, journal, pending.value.dispatch)


def test_queue_limit_env_override(monkeypatch):
    from app import pipeline_prediction_stages as stages
    monkeypatch.delenv('PIPELINE_GPU_QUEUE_MAX_SECONDS', raising=False)
    assert stages.queue_max_seconds() == 14400
    monkeypatch.setenv('PIPELINE_GPU_QUEUE_MAX_SECONDS', '600')
    assert stages.queue_max_seconds() == 600
    for bad in ('0', '-5', 'four hours'):
        monkeypatch.setenv('PIPELINE_GPU_QUEUE_MAX_SECONDS', bad)
        with pytest.raises(ValueError, match='queue_max_seconds_invalid'):
            stages.queue_max_seconds()


def test_actual_cpu_entrypoint_writes_a_receipt_and_cancels_through_modal(monkeypatch):
    from types import SimpleNamespace
    from google.cloud import storage
    import modal
    import modal_app
    from app import pipeline_prediction_stages as stages
    store, cancelled = Store(), []
    monkeypatch.setattr(modal_app, '_setup_env', lambda: None)
    monkeypatch.setattr(modal_app, '_get_gcs_bucket_name', lambda: 'fixture')
    monkeypatch.setattr(storage, 'Client', lambda: SimpleNamespace(bucket=lambda _: None))
    monkeypatch.setattr(stages, 'GCSStore', lambda _: store)
    monkeypatch.setattr(modal_app, '_hydrate_pipeline_prediction_request_reference', lambda ref: ref)
    monkeypatch.setattr(modal_app, '_pipeline_prediction_bundle_impl',
                        lambda _: stages.SCOPE.get().gpu({'x': 1}))
    monkeypatch.setattr(modal_app, 'timexer_universal_predict',
                        SimpleNamespace(spawn=lambda _: SimpleNamespace(object_id='fc-77')))
    monkeypatch.setattr(modal.FunctionCall, 'from_id',
                        lambda fc: SimpleNamespace(cancel=lambda: cancelled.append(fc)))
    assert modal_app.pipeline_prediction_bundle.local(reference())['status'] == 'waiting_gpu'
    receipts = {k: v[0] for k, v in store.rows.items() if '/dispatch/' in k}
    assert [r['function_call_ids'] for r in receipts.values()] == [['fc-77']]
    assert 'never-persist' not in str(store.rows)
    modal_app._cancel_gpu_call('fc-77')
    assert cancelled == ['fc-77']


def _crash(_):
    raise SystemExit('container killed')


def _queued_then_crashed(store, journal, now, start_at):
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    journal.dispatched(pending.value.dispatch, 'fc-' + pending.value.dispatch['token'][:4])
    with pytest.raises(SystemExit):
        run_gpu_stage(store, pending.value.dispatch, predict=_crash, resume=pytest.fail, clock=lambda: start_at)
    now[0] = start_at + GPU_LEASE_SECONDS
    return pending.value.dispatch


def test_a_started_container_at_the_queue_limit_keeps_its_lease_and_nothing_is_cancelled():
    class Racing(Store):
        dispatch = None
        def cas(self, key, value, generation):
            if value.get('abandoned') and self.dispatch is not None:
                dispatch, self.dispatch = self.dispatch, None
                def running(_):
                    raise SystemExit('still running when the driver checks')
                with pytest.raises(SystemExit):
                    run_gpu_stage(self, dispatch, predict=running, resume=pytest.fail, clock=lambda: 4 * 3600)
            return super().cas(key, value, generation)
    store, cancelled = Racing(), []
    with pytest.raises(Suspended) as pending:
        Journal(store, reference(), clock=lambda: 0).gpu({'x': 1})
    journal = Journal(store, reference(), clock=lambda: 4 * 3600, cancel=cancelled.append)
    journal.dispatched(pending.value.dispatch, 'fc-1')
    store.dispatch = pending.value.dispatch
    with pytest.raises(Suspended) as waiting:
        journal.gpu({'x': 1})
    assert waiting.value.dispatch is None and cancelled == []
    claim = _claim(store, journal, pending.value.dispatch)
    assert 'abandoned' not in claim and claim['until'] == 4 * 3600 + GPU_LEASE_SECONDS


def test_a_container_that_loses_its_start_to_an_abandon_does_not_run():
    class Racing(Store):
        journal = None
        def cas(self, key, value, generation):
            if self.journal is not None and 'started' in value:
                journal, self.journal = self.journal, None
                with pytest.raises(GpuStageUnavailable):
                    journal.gpu({'x': 1})
            return super().cas(key, value, generation)
    store = Racing()
    with pytest.raises(Suspended) as pending:
        Journal(store, reference(), clock=lambda: 0).gpu({'x': 1})
    store.journal = Journal(store, reference(), clock=lambda: 4 * 3600)
    assert run_gpu_stage(store, pending.value.dispatch, predict=lambda _: pytest.fail('ran'),
                         resume=pytest.fail, clock=lambda: 4 * 3600) == {'status': 'abandoned'}


def test_the_queue_limit_is_the_total_over_tokens_not_per_token():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    _queued_then_crashed(store, journal, now, start_at=3 * 3600)  # three hours queued
    with pytest.raises(Suspended) as second:
        journal.gpu({'x': 1})
    journal.dispatched(second.value.dispatch, 'fc-2')
    claim = _claim(store, journal, second.value.dispatch)
    assert claim['queued_before'] == 3 * 3600 and claim['queue_deadline'] == now[0] + 3600
    start = now[0]
    now[0] = start + 3599
    with pytest.raises(Suspended):
        journal.gpu({'x': 1})
    now[0] = start + 3600
    with pytest.raises(GpuStageUnavailable, match='queue_exhausted'):
        journal.gpu({'x': 1})


def test_an_expired_execution_uses_an_older_tokens_late_result_and_errors_never_count_as_valid():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    first = _queued_then_crashed(store, journal, now, start_at=10)
    second = _queued_then_crashed(store, journal, now, start_at=now[0])
    key = journal.root + '/gpu/' + first['stage'] + '/result/'
    with pytest.raises(Suspended) as third:
        journal.gpu({'x': 1})
    store.put(key + second['token'], {'input_checksum': first['stage'], 'error': 'OSError'})  # late error
    def boom(_):
        raise OSError('cuda')
    run_gpu_stage(store, third.value.dispatch, predict=boom, resume=lambda _: None, clock=lambda: now[0])
    # Error results are not valid: the current error stands while no token has a valid one.
    with pytest.raises(RuntimeError, match='gpu_failed:OSError'):
        journal.gpu({'x': 1})
    store.put(key + first['token'], {'input_checksum': first['stage'], 'value': {'ok': 1}})
    assert journal.gpu({'x': 1}) == {'ok': 1}


def test_attempt_exhaustion_rechecks_every_token_and_skips_error_results():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    tokens = [_queued_then_crashed(store, journal, now, start_at=now[0] + 10)['token'] for _ in range(3)]
    key = journal.root + '/gpu/' + digest_of({'x': 1}) + '/result/'
    store.put(key + tokens[1], {'input_checksum': digest_of({'x': 1}), 'error': 'OSError'})
    with pytest.raises(GpuStageUnavailable, match='attempts_exhausted'):
        journal.gpu({'x': 1})
    store.put(key + tokens[0], {'input_checksum': digest_of({'x': 1}), 'value': {'ok': 0}})
    assert journal.gpu({'x': 1}) == {'ok': 0}


def digest_of(payload):
    from app.pipeline_prediction_stages import digest
    return digest(payload)


def test_an_enclosing_stage_of_an_unavailable_gpu_is_not_sealed_either():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    journal.dispatched(pending.value.dispatch, 'fc-1')
    now[0] = 4 * 3600
    def child():
        try:
            return journal.gpu({'x': 1})
        except GpuStageUnavailable as exc:
            return {'error': str(exc), 'results': []}
    journal.cpu('atomic', 'slate', lambda: {'child': journal.cpu('ns', 'stage', child),
                                            'sibling': journal.cpu('ns', 'cpu_only', lambda: 7)})
    assert sorted(k for k in store.rows if '/cpu/' in k) == [journal.root + '/cpu/ns/cpu_only']
    assert journal.cpu('ns', 'after', lambda: 8) == 8 and journal.root + '/cpu/ns/after' in store.rows


def test_configuration_errors_are_not_sealed(monkeypatch):
    store = Store()
    journal = Journal(store, reference(), clock=lambda: 0)
    def stage():
        try:
            return journal.gpu({'x': 1})
        except ValueError as exc:
            return {'error': str(exc), 'results': []}
    monkeypatch.setenv('PIPELINE_GPU_QUEUE_MAX_SECONDS', 'bad')
    assert journal.cpu('ns', 'timexer', stage)['error'] == 'pipeline_gpu_queue_max_seconds_invalid'
    gpu = journal.root + '/gpu/' + digest_of({'x': 1})
    store.put(gpu + '/claim', {'token': 'a' * 32, 'until': 0, 'attempt': 1})
    assert journal.cpu('ns', 'timexer', stage)['error'] == 'pipeline_stage_gpu_claim_schema_invalid'
    assert not any('/cpu/' in k for k in store.rows)


def test_an_abandon_whose_cas_reports_conflict_but_landed_still_cancels_every_call():
    class Ghost(Store):
        def cas(self, key, value, generation):
            ok = super().cas(key, value, generation)
            return False if ok and value.get('abandoned') else ok
    store, now, cancelled = Ghost(), [0.], []
    journal = Journal(store, reference(), clock=lambda: now[0], cancel=cancelled.append)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    journal.dispatched(pending.value.dispatch, 'fc-1')
    journal.dispatched(pending.value.dispatch, 'fc-1b')  # a same-token re-send Modal also accepted
    now[0] = 4 * 3600
    with pytest.raises(GpuStageUnavailable, match='queue_exhausted'):
        journal.gpu({'x': 1})
    assert cancelled == ['fc-1', 'fc-1b']


def test_a_same_token_takeover_after_a_crash_before_execution_gets_its_own_lease():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    dispatch = pending.value.dispatch
    key = journal.root + '/gpu/' + dispatch['stage'] + '/claim'
    claim, generation = store.read(key)
    store.cas(key, {**claim, 'started': 100, 'until': 100 + GPU_LEASE_SECONDS, 'attempt': 1}, generation)
    def predict(_):
        with pytest.raises(Suspended) as waiting:  # The driver still sees a live lease.
            Journal(store, reference(), clock=lambda: 700 + GPU_LEASE_SECONDS - 1).gpu({'x': 1})
        assert waiting.value.dispatch is None
        return {'ok': 1}
    run_gpu_stage(store, dispatch, predict=predict, resume=lambda _: None, clock=lambda: 700)
    assert store.read(key)[0]['until'] == 700 + GPU_LEASE_SECONDS


def test_entrypoint_queue_limit_closes_the_run_through_the_error_callback(monkeypatch):
    from types import SimpleNamespace
    from google.cloud import storage
    import modal
    import modal_app
    from app import pipeline_prediction_stages as stages
    store, cancelled, errors = Store(), [], []
    monkeypatch.setattr(modal_app, '_setup_env', lambda: None)
    monkeypatch.setattr(modal_app, '_get_gcs_bucket_name', lambda: 'fixture')
    monkeypatch.setattr(storage, 'Client', lambda: SimpleNamespace(bucket=lambda _: None))
    monkeypatch.setattr(stages, 'GCSStore', lambda _: store)
    monkeypatch.setattr(modal_app, '_hydrate_pipeline_prediction_request_reference', lambda ref: ref)
    def impl(_):
        journal = stages.SCOPE.get()
        def stage():
            try:
                return journal.gpu({'x': 1})
            except Exception as exc:  # As _run_stage does.
                return {'error': f'{type(exc).__name__}: {exc}', 'results': []}
        out = journal.cpu('ns', 'timexer_universal_predict', stage)
        if out.get('error'):
            raise ValueError('pipeline_modal_timexer_cardinality_mismatch')
        return out
    monkeypatch.setattr(modal_app, '_pipeline_prediction_bundle_impl', impl)
    monkeypatch.setattr(modal_app, 'timexer_universal_predict',
                        SimpleNamespace(spawn=lambda _: SimpleNamespace(object_id='fc-77')))
    monkeypatch.setattr(modal.FunctionCall, 'from_id', lambda fc: SimpleNamespace(cancel=lambda: cancelled.append(fc)))
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_error_callback',
                        lambda payload, exc, elapsed: errors.append(str(exc)) or {'status': 'ok'})
    assert modal_app.pipeline_prediction_bundle.local(reference())['status'] == 'waiting_gpu'
    claim_key = next(k for k in store.rows if k.endswith('/claim'))
    claim, generation = store.read(claim_key)
    store.cas(claim_key, {**claim, 'queue_deadline': 1.0}, generation)
    with pytest.raises(ValueError, match='cardinality_mismatch'):
        modal_app.pipeline_prediction_bundle.local(reference())
    assert errors == ['pipeline_modal_timexer_cardinality_mismatch'] and cancelled == ['fc-77']
    assert any(k.endswith('/terminal') and v[0]['status'] == 'error_callback_accepted' for k, v in store.rows.items())
    assert not any('/cpu/ns/' in k for k in store.rows)


def test_an_enclosing_stage_that_catches_a_raised_unavailable_child_is_not_sealed():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    journal.dispatched(pending.value.dispatch, 'fc-1')
    now[0] = 4 * 3600
    def outer():
        try:
            return journal.cpu('ns', 'child', lambda: journal.gpu({'x': 1}))
        except GpuStageUnavailable as exc:
            return {'error': str(exc)}
    assert journal.cpu('atomic', 'slate', outer) == {'error': 'pipeline_stage_gpu_queue_exhausted'}
    assert not any('/cpu/' in k for k in store.rows)


def test_a_receipt_write_that_landed_despite_a_conflict_is_not_recorded_twice():
    class Ghost(Store):
        once = True
        def cas(self, key, value, generation):
            ok = super().cas(key, value, generation)
            if ok and '/dispatch/' in key and self.once:
                self.once = False
                return False
            return ok
    store = Ghost()
    journal = Journal(store, reference(), clock=lambda: 0)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    journal.dispatched(pending.value.dispatch, 'fc-1')
    receipt = next(v[0] for k, v in store.rows.items() if '/dispatch/' in k)
    assert receipt['function_call_ids'] == ['fc-1']


def test_two_concurrent_containers_of_one_token_run_the_gpu_once():
    store, runs, resumed = Store(), [], []
    journal = Journal(store, reference(), clock=lambda: 0)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    dispatch = pending.value.dispatch
    def first(payload):
        runs.append('first')
        # The duplicate arrives while the first is executing, after its start.
        assert run_gpu_stage(store, dispatch, predict=lambda _: runs.append('second'),
                             resume=resumed.append, clock=lambda: 20) == {'status': 'already_running'}
        return {'ok': 1}
    assert run_gpu_stage(store, dispatch, predict=first, resume=resumed.append, clock=lambda: 10)['status'] == 'resumed'
    assert runs == ['first'] and resumed == [reference()]
    assert journal.gpu({'x': 1}) == {'ok': 1}


def test_a_shadow_stage_that_gets_a_gpu_within_its_hour_runs_normally():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as pending:
        journal.gpu({'shadow': 1}, shadow=True)
    journal.dispatched(pending.value.dispatch, 'fc-s')
    claim = _claim(store, journal, pending.value.dispatch)
    assert claim['role'] == 'shadow' and claim['queue_deadline'] == 3600
    now[0] = 3599
    run_gpu_stage(store, pending.value.dispatch, predict=lambda _: {'shadow': 'ok'}, resume=lambda _: None,
                  clock=lambda: now[0])
    now[0] = 9000
    assert journal.gpu({'shadow': 1}, shadow=True) == {'shadow': 'ok'}


def test_a_shadow_stage_is_skipped_at_one_hour_while_a_formal_stage_keeps_queueing(capsys):
    store, now, cancelled = Store(), [0.], []
    journal = Journal(store, reference(), clock=lambda: now[0], cancel=cancelled.append)
    with pytest.raises(Suspended) as formal:
        journal.gpu({'formal': 1})
    journal.dispatched(formal.value.dispatch, 'fc-f')
    with pytest.raises(Suspended) as shadow:
        journal.gpu({'shadow': 1}, shadow=True)
    journal.dispatched(shadow.value.dispatch, 'fc-s')
    now[0] = 3599
    with pytest.raises(Suspended):
        journal.gpu({'shadow': 1}, shadow=True)
    now[0] = 3600
    def shadow_stage():
        try:
            return journal.gpu({'shadow': 1}, shadow=True)
        except GpuStageUnavailable as exc:
            return {'status': 'failed', 'error': str(exc)}
    assert journal.cpu('ns', 'shadow', shadow_stage) == {
        'status': 'failed', 'error': 'pipeline_stage_gpu_shadow_queue_exhausted'}
    assert cancelled == ['fc-s'] and 'shadow GPU stage skipped' in capsys.readouterr().out
    assert not any('/cpu/' in k for k in store.rows)
    with pytest.raises(Suspended) as still:
        journal.gpu({'formal': 1})  # The formal stage keeps its four hours.
    assert still.value.dispatch is None and 'abandoned' not in _claim(store, journal, formal.value.dispatch)
    now[0] = 4 * 3600
    with pytest.raises(GpuStageUnavailable, match='^pipeline_stage_gpu_queue_exhausted$'):
        journal.gpu({'formal': 1})


def test_a_shadow_keeps_its_role_and_limit_across_tokens_and_the_flag_cannot_relabel_a_claim():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as first:
        journal.gpu({'shadow': 1}, shadow=True)
    with pytest.raises(SystemExit):
        run_gpu_stage(store, first.value.dispatch, predict=_crash, resume=pytest.fail, clock=lambda: 600)
    now[0] = 600 + GPU_LEASE_SECONDS
    with pytest.raises(Suspended) as second:
        journal.gpu({'shadow': 1})  # Even without the flag, the stage stays a shadow.
    claim = _claim(store, journal, second.value.dispatch)
    assert claim['role'] == 'shadow' and claim['queue_deadline'] == now[0] + 3600 - 600


def test_shadow_queue_limit_env_override(monkeypatch):
    from app import pipeline_prediction_stages as stages
    monkeypatch.delenv('PIPELINE_GPU_SHADOW_QUEUE_MAX_SECONDS', raising=False)
    monkeypatch.setenv('PIPELINE_GPU_QUEUE_MAX_SECONDS', '99')
    assert stages.queue_max_seconds(True) == 3600 and stages.queue_max_seconds() == 99
    monkeypatch.setenv('PIPELINE_GPU_SHADOW_QUEUE_MAX_SECONDS', '120')
    assert stages.queue_max_seconds(True) == 120
    for bad in ('0', '-1', 'an hour'):
        monkeypatch.setenv('PIPELINE_GPU_SHADOW_QUEUE_MAX_SECONDS', bad)
        with pytest.raises(ValueError, match='^pipeline_gpu_shadow_queue_max_seconds_invalid$'):
            stages.queue_max_seconds(True)


def test_the_shadow_candidate_runner_records_a_skipped_shadow_and_routes_timexer_as_shadow():
    from pathlib import Path
    import modal_app
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as pending:
        journal.gpu({'series_list': [{'symbol': '2330'}]}, shadow=True)
    journal.dispatched(pending.value.dispatch, 'fc-s')
    now[0] = 3600
    out = modal_app._run_active8_sequence_shadow_candidates(
        candidate_series_by_model={'TimeXer': [{'symbol': '2330'}]},
        candidate_entries={'TimeXer': {'candidate_type': 'shadow'}},
        candidate_identities={'TimeXer': {'version': 'v9', 'artifact_id': 'a', 'checksum': 'c'}},
        predictors={'TimeXer': lambda **kw: journal.gpu({'series_list': kw['series_list']}, shadow=True)})
    candidate = out['candidates']['TimeXer']
    assert candidate['status'] == 'failed' and out['production_effect'] is False
    assert candidate['error'] == 'GpuStageUnavailable: pipeline_stage_gpu_shadow_queue_exhausted'
    source = (Path(modal_app.__file__)).read_text()
    assert '"TimeXer": lambda **kwargs: _timexer_predict(shadow=True, **kwargs),' in source
    assert 'stage_journal.gpu(gpu_input, shadow=shadow)' in source
    import ast
    formal = next(node for node in ast.walk(ast.parse(source))
                  if isinstance(node, ast.FunctionDef) and node.name == '_timexer')
    calls = [node for node in ast.walk(formal) if isinstance(node, ast.Call)
             and getattr(node.func, 'id', None) == '_timexer_predict']
    assert calls and all(keyword.arg != 'shadow' for call in calls for keyword in call.keywords)


def test_after_one_shadow_is_skipped_later_shadows_of_the_run_skip_without_queueing():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as first:
        journal.gpu({'shadow': 1}, shadow=True)
    journal.dispatched(first.value.dispatch, 'fc-s1')
    now[0] = 3600
    with pytest.raises(GpuStageUnavailable, match='shadow_queue_exhausted'):
        journal.gpu({'shadow': 1}, shadow=True)
    with pytest.raises(GpuStageUnavailable, match='shadow_queue_exhausted'):
        journal.gpu({'shadow': 2}, shadow=True)  # No new request, no second hour.
    assert not any(key.endswith('/claim') and '/gpu/' + digest_of({'shadow': 2}) in key for key in store.rows)
    with pytest.raises(Suspended) as formal:
        journal.gpu({'formal': 1})  # Formal stages are unaffected by the shadow skip.
    assert formal.value.dispatch is not None


def test_a_request_that_started_after_its_deadline_and_failed_is_not_queued_again():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    journal.dispatched(pending.value.dispatch, 'fc-1')
    late = 4 * 3600 + 10  # Started before the driver got to abandon it.
    with pytest.raises(SystemExit):
        run_gpu_stage(store, pending.value.dispatch, predict=_crash, resume=pytest.fail, clock=lambda: late)
    now[0] = late + GPU_LEASE_SECONDS
    with pytest.raises(GpuStageUnavailable, match='^pipeline_stage_gpu_queue_exhausted$'):
        journal.gpu({'x': 1})
    claim = _claim(store, journal, pending.value.dispatch)
    assert claim['abandoned'] is True and claim['tokens'] == [pending.value.dispatch['token']]


def test_each_resend_waits_its_own_grace():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended):
        journal.gpu({'x': 1})
    sent = []
    for t in (600, 700, 1199, 1200):
        now[0] = t
        with pytest.raises(Suspended) as again:
            journal.gpu({'x': 1})
        sent.append(again.value.dispatch is not None)
    assert sent == [True, False, False, True]


@pytest.mark.parametrize('raw', ['+60', '14_400', ' 60x', '６０'])
def test_queue_limits_accept_plain_decimal_seconds_only(monkeypatch, raw):
    from app import pipeline_prediction_stages as stages
    monkeypatch.setenv('PIPELINE_GPU_QUEUE_MAX_SECONDS', raw)
    with pytest.raises(ValueError, match='queue_max_seconds_invalid'):
        stages.queue_max_seconds()


def test_a_takeover_whose_lease_renewal_loses_to_an_abandon_does_not_run():
    class Racing(Store):
        armed = False
        def cas(self, key, value, generation):
            if self.armed and key.endswith('/claim') and not value.get('abandoned'):
                self.armed = False
                current, version = self.read(key)
                super().cas(key, {**current, 'abandoned': True}, version)  # The driver gives up first.
            return super().cas(key, value, generation)
    store = Racing()
    journal = Journal(store, reference(), clock=lambda: 0)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    dispatch = pending.value.dispatch
    key = journal.root + '/gpu/' + dispatch['stage'] + '/claim'
    claim, generation = store.read(key)
    store.cas(key, {**claim, 'started': 100, 'until': 100 + GPU_LEASE_SECONDS, 'attempt': 1}, generation)
    store.armed = True
    assert run_gpu_stage(store, dispatch, predict=lambda _: pytest.fail('ran after abandon'),
                         resume=pytest.fail, clock=lambda: 700) == {'status': 'abandoned'}


def test_a_takeover_whose_lease_renewal_finds_a_newer_token_does_not_run():
    class Racing(Store):
        armed = False
        def cas(self, key, value, generation):
            if self.armed and key.endswith('/claim'):
                self.armed = False
                current, version = self.read(key)
                super().cas(key, {**current, 'token': 'f' * 32}, version)  # A newer attempt took over.
            return super().cas(key, value, generation)
    store = Racing()
    journal = Journal(store, reference(), clock=lambda: 0)
    with pytest.raises(Suspended) as pending:
        journal.gpu({'x': 1})
    dispatch = pending.value.dispatch
    key = journal.root + '/gpu/' + dispatch['stage'] + '/claim'
    claim, generation = store.read(key)
    store.cas(key, {**claim, 'started': 100, 'until': 100 + GPU_LEASE_SECONDS, 'attempt': 1}, generation)
    store.armed = True
    assert run_gpu_stage(store, dispatch, predict=lambda _: pytest.fail('ran for a stale token'),
                         resume=pytest.fail, clock=lambda: 700) == {'status': 'superseded'}


def test_the_shadow_flag_never_enters_the_gpu_input_or_its_stage_digest():
    import ast
    from pathlib import Path
    import modal_app
    tree = ast.parse(Path(modal_app.__file__).read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == '_timexer_predict')
    assert [a.arg for a in fn.args.kwonlyargs] == ['shadow'] and fn.args.kwarg.arg == 'kwargs'
    def target(node):  # gpu_input = ... or gpu_input[...] = ...
        return isinstance(node, ast.Name) and node.id == 'gpu_input' or (
            isinstance(node, ast.Subscript) and getattr(node.value, 'id', '') == 'gpu_input')
    writes = [n for n in ast.walk(fn) if isinstance(n, ast.Assign) and any(target(t) for t in n.targets)]
    assert len(writes) == 2
    assert not any(isinstance(n, ast.Name) and n.id == 'shadow' or isinstance(n, ast.Constant) and n.value == 'shadow'
                   for w in writes for n in ast.walk(w))
    gpu_calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and getattr(n.func, 'attr', '') == 'gpu']
    assert len(gpu_calls) == 1 and getattr(gpu_calls[0].args[0], 'id', '') == 'gpu_input'
    assert [k.arg for k in gpu_calls[0].keywords] == ['shadow']
