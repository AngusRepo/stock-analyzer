import io,zipfile
import pytest
from app.l4_r2_job import validate_request,extract


@pytest.mark.parametrize('seed',[42,43,44])
def test_fixed_seed_and_batch_scope(seed):
    value={'seed':seed,'batch_id':'a'*64,'inputs':{'path':'l4_distribution/r2_batches/'+('a'*64)+'/inputs.zip','sha256':'b'*64}}
    assert validate_request(value).endswith(f'/seed{seed}/')
    value['seed']=45
    with pytest.raises(ValueError):validate_request(value)


@pytest.mark.parametrize('name',['../outside','/absolute','C:/absolute','safe\\bad'])
def test_archive_paths_checked_before_extraction(name):
    buffer=io.BytesIO()
    info=zipfile.ZipInfo('placeholder');info.filename=name
    with zipfile.ZipFile(buffer,'w') as z:z.writestr(info,b'bad')
    with pytest.raises(ValueError,match='unsafe_archive'):extract(buffer.getvalue(),'never-created')


import hashlib,json
from app import l4_r2_job
from app.l4_r2_job import prune_targets,prune


def test_prune_targets_only_unselected_checkpoints():
    names=['cv/fold1/epoch003.pt','cv/fold1/epoch004.pt','cv/fold4/epoch007.pt','cv/fold5/epoch004.pt',
           'final/epoch004.pt','final/epoch007.pt','cv/predictions/epoch004.npz','events/epoch004.json',
           'selection.json','weights.npz','../final/epoch004.pt','final/epoch004.pt.bak']
    assert prune_targets(names,[[3,0],[7,5],[3,9]])==['cv/fold1/epoch004.pt','final/epoch004.pt']


class Blob:
    def __init__(self,store,name,raw=b'x'):
        self.store,self.name,self.raw,self.generation,self.size=store,name,raw,1,len(raw)
        self.metadata={'sha256':hashlib.sha256(raw).hexdigest()}
    def download_as_bytes(self,if_generation_match=None):return self.raw
    def delete(self,if_generation_match=None):
        if self.store.fail_delete:raise RuntimeError('boom')
        assert if_generation_match==self.generation;del self.store.blobs[self.name]
    def upload_from_string(self,raw,if_generation_match=None):self.store.uploads[self.name]=raw


class Bucket:
    def __init__(self,prefix,selected,names,fail_delete=False):
        self.fail_delete=fail_delete;self.uploads={}
        self.blobs={prefix+n:Blob(self,prefix+n) for n in names}
        self.blobs[prefix+'selection.json']=Blob(self,prefix+'selection.json',json.dumps({'selected':selected}).encode())
    def get_blob(self,name):return self.blobs.get(name)
    def list_blobs(self,prefix):return [b for n,b in list(self.blobs.items()) if n.startswith(prefix)]
    def blob(self,name):return self.blobs.get(name) or Blob(self,name)


PREFIX='l4_distribution/r2_batches/'+'a'*64+'/seed42/'
NAMES=['cv/fold1/epoch001.pt','cv/fold1/epoch002.pt','final/epoch001.pt','final/epoch002.pt',
       'cv/predictions/epoch001.npz','weights.npz','checkpoint-verification.json']


def test_prune_deletes_unselected_and_writes_receipt():
    bucket=Bucket(PREFIX,[[2,0]],NAMES)
    result=prune(bucket,PREFIX)
    assert result['status']=='pruned' and result['deleted_count']==2 and result['deleted_bytes']==2
    assert sorted(n[len(PREFIX):] for n in bucket.blobs)==sorted(['cv/fold1/epoch002.pt','final/epoch002.pt',
        'cv/predictions/epoch001.npz','weights.npz','checkpoint-verification.json','selection.json'])
    assert json.loads(bucket.uploads[PREFIX+'checkpoint-prune.json'])['deleted'][0]['name']=='cv/fold1/epoch001.pt'


def test_prune_refuses_tampered_selection():
    bucket=Bucket(PREFIX,[[2,0]],NAMES);bucket.blobs[PREFIX+'selection.json'].metadata={'sha256':'0'*64}
    assert prune(bucket,PREFIX)['status']=='failed' and len(bucket.blobs)==len(NAMES)+1


def test_prune_failure_never_raises():
    bucket=Bucket(PREFIX,[[2,0]],NAMES,fail_delete=True)
    result=prune(bucket,PREFIX)
    assert result=={'status':'failed','error_type':'RuntimeError','deleted':[],'deleted_count':0,'deleted_bytes':0}
    assert PREFIX+'checkpoint-prune.json' in bucket.uploads


def test_verified_seed_returns_without_pruning(monkeypatch):
    from google.cloud import storage
    class Verified:
        def exists(self):return True
        def download_as_bytes(self):return b'{"status": "passed"}'
    class Client:
        def bucket(self,name):
            class B:
                def blob(self,name):return Verified()
            return B()
    monkeypatch.setattr(storage,'Client',Client)
    monkeypatch.setattr(l4_r2_job,'prune',lambda *a:pytest.fail('must not prune an already verified seed'))
    payload={'seed':42,'batch_id':'a'*64,'inputs':{'path':'l4_distribution/r2_batches/'+('a'*64)+'/inputs.zip','sha256':'b'*64}}
    assert l4_r2_job.run(payload)=={'status':'passed'}


def test_prune_targets_refuses_empty_selection():
    with pytest.raises(ValueError,match='empty_selection'):prune_targets(['cv/fold1/epoch001.pt'],[])


def _seal_zip():
    core={'schema':'test-seal'}
    batch=hashlib.sha256(json.dumps(core,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,'w') as z:z.writestr('batch-seal.json',json.dumps({**core,'batch_id':batch}))
    return batch,buffer.getvalue()


@pytest.mark.parametrize('fail_delete',[False,True])
def test_run_prunes_only_after_verification_is_durable(monkeypatch,tmp_path,fail_delete):
    from pathlib import Path
    from google.cloud import storage
    from google.api_core.exceptions import PreconditionFailed
    batch,raw=_seal_zip();prefix='l4_distribution/r2_batches/'+batch+f'/seed42/'
    bucket=Bucket(prefix,[[2,0]],[],fail_delete=fail_delete);bucket.name='stockvision-models'
    bucket.blobs['l4_distribution/r2_batches/'+batch+'/inputs.zip']=Blob(bucket,'inputs.zip',raw)
    class Durable(Blob):
        def exists(self):return self.name in self.store.blobs
        def download_as_bytes(self,if_generation_match=None):return self.store.blobs[self.name].raw
        def upload_from_string(self,raw,if_generation_match=None):
            if if_generation_match==0 and self.name in self.store.blobs:raise PreconditionFailed('exists')
            self.raw=raw;self.store.blobs[self.name]=self
    bucket.blob=lambda name:bucket.blobs.get(name) or Durable(bucket,name)
    monkeypatch.setattr(storage,'Client',lambda:type('C',(),{'bucket':lambda self,name:bucket})())
    proof_path=Path('/tmp/checkpoint-verification.json')
    def fake_run(cmd,check,timeout):
        if cmd[1].endswith('r2_train.py'):
            for name in NAMES[:5]:bucket.blobs[prefix+name]=Blob(bucket,prefix+name)
        else:
            assert prefix+'checkpoint-verification.json' not in bucket.blobs
            proof_path.parent.mkdir(exist_ok=True);proof_path.write_text(json.dumps({'status':'passed','training_steps':0}))
    monkeypatch.setattr(l4_r2_job.subprocess,'run',fake_run)
    delete=Blob.delete
    def durable_first(self,if_generation_match=None):
        assert prefix+'checkpoint-verification.json' in bucket.blobs
        delete(self,if_generation_match=if_generation_match)
    monkeypatch.setattr(Blob,'delete',durable_first)
    payload={'seed':42,'batch_id':batch,'inputs':{'path':'l4_distribution/r2_batches/'+batch+'/inputs.zip',
        'sha256':hashlib.sha256(raw).hexdigest()}}
    try:proof=l4_r2_job.run(payload)
    finally:proof_path.unlink(missing_ok=True)
    assert proof['status']=='passed' and prefix+'failed.json' not in bucket.blobs
    assert prefix+'checkpoint-verification.json' in bucket.blobs
    receipt=json.loads(bucket.blobs[prefix+'checkpoint-prune.json'].raw)
    left={n[len(prefix):] for n in bucket.blobs if n.startswith(prefix)}
    if fail_delete:
        assert receipt['status']=='failed' and {'cv/fold1/epoch001.pt','final/epoch001.pt'}<=left
    else:
        assert receipt['status']=='pruned' and receipt['deleted_count']==2
        assert not {'cv/fold1/epoch001.pt','final/epoch001.pt'}&left and {'cv/fold1/epoch002.pt','final/epoch002.pt'}<=left
