import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import NotFound,PreconditionFailed
from app.training_call_journal import TrainingCallJournal,release_journal

class Bucket:
    def __init__(self):self.records={};self.fail_dispatched=False
    def blob(self,key):
        store=self
        class Blob:
            def reload(self):
                if key not in store.records:raise NotFound(key)
                self.generation=store.records[key][0]
            def download_as_bytes(self,if_generation_match):
                generation,raw=store.records[key]
                if generation!=if_generation_match:raise PreconditionFailed(key)
                return raw
            def upload_from_string(self,raw,content_type,if_generation_match):
                old=store.records.get(key,(0,b''))
                if old[0]!=if_generation_match:raise PreconditionFailed(key)
                if store.fail_dispatched and json.loads(raw).get('state')=='dispatched':
                    raise RuntimeError('process_lost_before_call_id_persisted')
                store.records[key]=(old[0]+1,raw)
        return Blob()

class Jobs:
    def __init__(self):self.payloads=[];self.fail_once=False;self.reads=0
    def spawn(self,payload):
        self.payloads.append(deepcopy(payload))
        return SimpleNamespace(object_id='fc-'+str(len(self.payloads)))
    def from_id(self,call_id):
        def get():
            self.reads+=1
            if self.fail_once:self.fail_once=False;raise RuntimeError('coordinator_interrupted')
            return {'model_artifact':'immutable-'+call_id,'checksum':'b'*64}
        return SimpleNamespace(get=get)

def journal(bucket,jobs,source='a'*40):
    return TrainingCallJournal(bucket,run_id='original-fullfit',source_sha=source,scope='root',from_id=jobs.from_id)

def test_restart_reuses_dispatched_call_and_persists_original_result():
    bucket,jobs=Bucket(),Jobs();j=journal(bucket,jobs)
    jobs.fail_once=True
    with pytest.raises(RuntimeError,match='coordinator_interrupted'):j.spawn('TimeXer',jobs.spawn,{'version':'v1'}).get()
    result=journal(bucket,jobs).spawn('TimeXer',jobs.spawn,{'version':'v1'}).get()
    assert len(jobs.payloads)==1 and result['model_artifact']=='immutable-fc-1'
    jobs.from_id=lambda _:pytest.fail('completed result must not need Modal retention')
    replay=journal(bucket,jobs).spawn('TimeXer',jobs.spawn,{'version':'v1'}).get()
    assert replay==result and len(jobs.payloads)==1

def test_restart_keeps_version_and_rejects_changed_run():
    bucket,jobs=Bucket(),Jobs();p={'dataset':'verified','run_id':'original-fullfit'}
    assert journal(bucket,jobs).pin_version(p,'v1')=='v1'
    assert journal(bucket,jobs).pin_version(p,'v2')=='v1'
    with pytest.raises(ValueError,match='run_payload_changed'):journal(bucket,jobs).pin_version({**p,'dataset':'other'},'v3')

@pytest.mark.parametrize('change',['payload','source'])
def test_existing_call_cannot_be_reused_for_different_training(change):
    bucket,jobs=Bucket(),Jobs();journal(bucket,jobs).spawn('TabM',jobs.spawn,{'version':'v1'})
    with pytest.raises(ValueError):
        journal(bucket,jobs,source='c'*40 if change=='source' else 'a'*40).spawn('TabM',jobs.spawn,{'version':'v2' if change=='payload' else 'v1'})
    assert len(jobs.payloads)==1

def test_unknown_dispatch_outcome_never_launches_second_paid_job():
    bucket,jobs=Bucket(),Jobs();bucket.fail_dispatched=True
    with pytest.raises(RuntimeError,match='process_lost'):journal(bucket,jobs).spawn('GNN',jobs.spawn,{'version':'v1'})
    bucket.fail_dispatched=False
    with pytest.raises(RuntimeError,match='outcome_unknown'):journal(bucket,jobs).spawn('GNN',jobs.spawn,{'version':'v1'})
    assert len(jobs.payloads)==1

def test_two_coordinators_can_read_same_completed_result_without_new_dispatch():
    bucket,jobs=Bucket(),Jobs();j=journal(bucket,jobs)
    one=j.spawn('XGBoost',jobs.spawn,{});two=journal(bucket,jobs).spawn('XGBoost',jobs.spawn,{})
    assert one.get()==two.get() and len(jobs.payloads)==1

def test_corrupt_record_blocks_resubmission():
    bucket,jobs=Bucket(),Jobs();journal(bucket,jobs).spawn('PatchTST',jobs.spawn,{})
    key=next(iter(bucket.records));generation,raw=bucket.records[key];row=json.loads(raw);row['call_id']='fc-evil'
    bucket.records[key]=(generation,json.dumps(row).encode())
    with pytest.raises(ValueError,match='corrupt'):journal(bucket,jobs).spawn('PatchTST',jobs.spawn,{})
    assert len(jobs.payloads)==1

def test_legacy_training_does_not_initialize_journal():
    assert release_journal({'candidate_type':'legacy'},scope='root',bucket_name=None) is None

@pytest.mark.parametrize('bad_run,bad_source',[(None,'a'*40),('id',''),('id','not-a-commit')])
def test_release_requires_stable_run_and_real_source(bad_run,bad_source):
    with pytest.raises(ValueError,match='identity_missing'):
        TrainingCallJournal(Bucket(),run_id=bad_run,source_sha=bad_source,scope='root',from_id=lambda _:None)

def test_actual_tree_reducer_restart_does_not_spawn_three_models_again(monkeypatch):
    import modal_app
    from app import training_call_journal,training_finalizer
    bucket,jobs=Bucket(),Jobs()
    monkeypatch.setattr(modal_app,'_setup_env',lambda:None)
    monkeypatch.setattr(training_call_journal,'release_journal',lambda *a,**kw:journal(bucket,jobs))
    monkeypatch.setattr(modal_app,'train_tree_model',SimpleNamespace(spawn=jobs.spawn))
    monkeypatch.setattr(modal_app,'_combine_tree_child_oos_artifacts',lambda *a:(None,None))
    monkeypatch.setattr(training_finalizer,'reduce_tree_model_child_results',lambda rows,**kw:dict(rows))
    payload={'candidate_type':'oof_full_fit_release','run_id':'original-fullfit','output_model_version':'v1'}
    jobs.fail_once=True
    first=modal_app.train_tree_models_split_parent.get_raw_f()(payload)
    assert first['error']=='coordinator_interrupted' and len(jobs.payloads)==3
    second=modal_app.train_tree_models_split_parent.get_raw_f()(payload)
    assert set(second)=={'LightGBM','XGBoost','ExtraTrees'} and len(jobs.payloads)==3
    assert {r['model_artifact'] for r in second.values()}=={'immutable-fc-1','immutable-fc-2','immutable-fc-3'}


def test_object_disappearing_after_metadata_read_does_not_resubmit():
    jobs=Jobs()
    class DisappearingBucket:
        def blob(self,key):
            class Blob:
                generation=1
                def reload(self):pass
                def download_as_bytes(self,**kwargs):raise NotFound(key)
            return Blob()
    with pytest.raises(NotFound):journal(DisappearingBucket(),jobs).spawn('TimeXer',jobs.spawn,{})
    assert jobs.payloads==[]


def test_fresh_and_resumed_reads_share_existing_json_callback_types():
    bucket,jobs=Bucket(),Jobs()
    jobs.from_id=lambda _:SimpleNamespace(get=lambda:{'feature_policy':{'allowed_selection_methods':('cpcv','full137')},'checksum':'d'*64,'score':0.123})
    first=journal(bucket,jobs).spawn('LightGBM',jobs.spawn,{}).get()
    restored=journal(bucket,jobs).spawn('LightGBM',jobs.spawn,{}).get()
    assert first==restored=={'feature_policy':{'allowed_selection_methods':['cpcv','full137']},'checksum':'d'*64,'score':0.123}
    assert len(jobs.payloads)==1
