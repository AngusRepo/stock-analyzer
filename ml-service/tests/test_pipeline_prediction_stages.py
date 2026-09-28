from copy import deepcopy
import pytest
from app.pipeline_prediction_stages import Journal, Suspended, run_gpu_stage, namespace


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


def test_lost_dispatch_ack_is_bounded_and_late_attempt_cannot_replace_current():
    store, now = Store(), [0.]
    journal = Journal(store, reference(), clock=lambda: now[0])
    with pytest.raises(Suspended) as first:
        journal.gpu({'x': 1})
    with pytest.raises(Suspended) as wait:
        journal.gpu({'x': 1})
    assert wait.value.dispatch is None
    now[0] = 1051
    with pytest.raises(Suspended) as second:
        journal.gpu({'x': 1})
    calls = []
    assert run_gpu_stage(store, first.value.dispatch, predict=calls.append,
                         resume=calls.append, clock=lambda: now[0])['status'] == 'superseded'
    assert calls == []
    run_gpu_stage(store, second.value.dispatch, predict=lambda p: {'result': 2},
                  resume=calls.append, clock=lambda: now[0])
    assert journal.gpu({'x': 1}) == {'result': 2}
    # Independent input gets its own bounded attempt counter.
    for i in range(3):
        with pytest.raises(Suspended):
            journal.gpu({'x': 2})
        now[0] += 1051
    with pytest.raises(RuntimeError, match='attempts_exhausted'):
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


def test_expired_gpu_queue_resumes_without_doing_work():
    store,queue=Store(),[]
    journal=Journal(store,reference(),clock=lambda:0)
    with pytest.raises(Suspended) as pending:journal.gpu({'x':1})
    assert run_gpu_stage(store,pending.value.dispatch,predict=lambda _:pytest.fail('expired'),
        resume=queue.append,clock=lambda:1051)['status']=='expired_resumed'
    assert queue==[reference()]

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
