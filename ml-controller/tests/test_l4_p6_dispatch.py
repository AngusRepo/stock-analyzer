import hashlib,json
from types import SimpleNamespace
from datetime import datetime,timezone
import pytest
from google.api_core.exceptions import PreconditionFailed
from services import l4_p6_dispatch as owner


class Bucket:
    def __init__(self):self.objects={}
    def blob(self,path):
        bucket=self
        class Blob:
            name=path;metadata=None;generation=1
            def upload_from_string(self,raw,**kwargs):
                assert kwargs['if_generation_match']==0
                if path in bucket.objects:raise PreconditionFailed('exists')
                bucket.objects[path]=(raw,dict(self.metadata or {}))
            def download_as_bytes(self,**kwargs):
                assert kwargs['if_generation_match']==1
                return bucket.objects[path][0]
        result=Blob()
        if path in self.objects:result.metadata=self.objects[path][1]
        return result
    def get_blob(self,path):return self.blob(path) if path in self.objects else None


def setup():
    bucket=Bucket();path=f"l4_distribution/p6_batches/{'a'*64}/inputs.zip";raw=b'sealed inputs'
    sha=hashlib.sha256(raw).hexdigest();bucket.objects[path]=(raw,{'sha256':sha})
    source=dict(recipe=owner.RECIPE,phase='cv',batch_id='a'*64,inputs=dict(path=path,sha256=sha,bytes=len(raw),generation='1'))
    return bucket,source


def test_three_seeds_dispatched_once_and_complete_is_not_release():
    bucket,source=setup();calls=[]
    def spawn(payload):calls.append(payload);return SimpleNamespace(object_id='call-'+str(payload['seed']))
    result=owner.advance(bucket,source,spawn=spawn)
    assert result['pending_seeds']==[42,43,44] and len(calls)==3
    assert owner.advance(bucket,source,spawn=spawn)['status']=='pending' and len(calls)==3
    for seed in (42,43,44):
        prefix=f"l4_distribution/p6_batches/{'a'*64}/cv/seed{seed}/"
        owner.put(bucket,prefix+'completed.json',dict(schema_version='p6-seed-result-v1',recipe=owner.RECIPE,
            sealed_batch_id='a'*64,seed=seed,phase='cv',training_completed=True,promoted=False,outer_rows=0,
            checkpoint_restoration=[{'training_steps':0}]))
    result=owner.advance(bucket,source,spawn=spawn)
    assert result['status']=='phase_complete' and result['collection_required'] and result['promoted'] is False
    assert len(calls)==3 and result['final_artifact_admitted'] is False


def test_failed_seed_prevents_dispatch_of_earlier_unstarted_seeds():
    bucket,source=setup();bucket.objects[f"l4_distribution/p6_batches/{'a'*64}/cv/seed44/failed.json"]=(b'{}',{})
    result=owner.advance(bucket,source,spawn=lambda p:pytest.fail('new training after failure'))
    assert result['status']=='needs_review' and result['failed_seeds']==[44]


def test_lost_spawn_acknowledgement_keeps_claim_and_never_retries():
    bucket,source=setup()
    def broken(payload):raise RuntimeError('lost acknowledgement')
    with pytest.raises(RuntimeError):owner.advance(bucket,source,spawn=broken)
    result=owner.advance(bucket,source,spawn=lambda p:pytest.fail('duplicate fit'))
    assert result['status']=='needs_review' and result['seed_states'][42]=='ambiguous'


def test_wrong_input_generation_cannot_start_training():
    bucket,source=setup();source['inputs']['generation']='2'
    with pytest.raises(ValueError,match='object_reference_changed'):
        owner.advance(bucket,source,spawn=lambda p:pytest.fail('bad source'))
