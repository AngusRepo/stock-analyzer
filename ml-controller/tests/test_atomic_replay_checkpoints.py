import hashlib
import json
import gzip
import pytest
from services.atomic_replay_checkpoints import AtomicReplayCheckpoints, AtomicReplayDeadlineExceeded

class Bucket:
    def __init__(self): self.objects = {}
    def blob(self, key):
        bucket = self
        class Blob:
            name = key
            def upload_from_string(self, raw, **kwargs):
                assert kwargs['if_generation_match'] == 0
                bucket.objects[key] = raw
            def download_as_bytes(self, **kwargs): return bucket.objects[key]
        return Blob()
    def list_blobs(self, prefix):
        return [self.blob(key) for key in self.objects if key.startswith(prefix)]

def test_durable_cache_survives_new_process_directory_and_isolates_kernel(tmp_path):
    runner = tmp_path/'runner.cjs'; runner.write_text('original kernel')
    a=tmp_path/'a';a.mkdir();b=tmp_path/'b';b.mkdir()
    bucket=Bucket();request={'signalDate':'2026-10-14','producerRunId':'exact-original'}
    body=json.dumps({'replacement':1,'candidate':{'status':'materialized'}})
    name='a'*64+'.json.gz'
    raw=gzip.compress(json.dumps({'key':'a'*64,'body':body,'sha256':hashlib.sha256(body.encode()).hexdigest()}).encode())
    with AtomicReplayCheckpoints(a,runner,request,bucket):
        (a/name).write_bytes(raw)
    with AtomicReplayCheckpoints(b,runner,request,bucket):
        assert (b/name).read_bytes()==raw
    runner.write_text('different kernel')
    c=tmp_path/'c';c.mkdir()
    with AtomicReplayCheckpoints(c,runner,request,bucket): assert not list(c.iterdir())

def test_corrupt_cloud_checkpoint_fails_closed(tmp_path):
    runner=tmp_path/'runner.cjs';runner.write_text('kernel')
    directory=tmp_path/'cache';directory.mkdir();bucket=Bucket()
    store=AtomicReplayCheckpoints(directory,runner,{},bucket)
    bucket.objects[store.prefix+'a'*64+'.json.gz']=gzip.compress(b'{}')
    with pytest.raises(ValueError,match='checksum_invalid'):store.restore()


def test_rpc_and_rate_limit_retry_share_deadline_without_sdk_reset(tmp_path,monkeypatch):
    from services import atomic_replay_checkpoints as module
    from google.api_core.exceptions import TooManyRequests
    runner=tmp_path/'runner';runner.write_text('kernel')
    clock=[100.0];calls=[]
    monkeypatch.setattr(module.time,'sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds))
    store=AtomicReplayCheckpoints(tmp_path,runner,{},deadline=110,clock=lambda:clock[0])
    def read(**options):
        calls.append(options)
        if len(calls)==1:
            clock[0]+=4
            raise TooManyRequests('quota')
        return b'verified fixture'
    assert store.rpc(read)==b'verified fixture'
    assert calls==[{'timeout':10,'retry':None},{'timeout':5,'retry':None}]
    clock[0]=110
    with pytest.raises(AtomicReplayDeadlineExceeded):store.rpc(read)
    assert len(calls)==2


def test_checkpoint_transient_retry_is_not_reduced_to_three_attempts(tmp_path,monkeypatch):
    from services import atomic_replay_checkpoints as module
    from google.api_core.exceptions import ServiceUnavailable
    runner=tmp_path/'runner';runner.write_text('kernel');clock=[100.0];calls=[]
    monkeypatch.setattr(module.time,'sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds))
    store=AtomicReplayCheckpoints(tmp_path,runner,{},deadline=300,clock=lambda:clock[0])
    def read(**options):
        calls.append(options)
        if len(calls)<5:raise ServiceUnavailable('transient')
        return b'recovered'
    assert store.rpc(read)==b'recovered'
    assert len(calls)==5 and clock[0]==115


def test_expired_restore_never_starts_network(tmp_path):
    runner=tmp_path/'runner';runner.write_text('kernel')
    store=AtomicReplayCheckpoints(tmp_path,runner,{},Bucket(),deadline=100,clock=lambda:100)
    with pytest.raises(AtomicReplayDeadlineExceeded):store.__enter__()


def test_shared_deadline_is_recomputed_for_each_list_page(tmp_path):
    from types import SimpleNamespace
    runner=tmp_path/'runner';runner.write_text('kernel');clock=[10.0];calls=[]
    class Pages:
        def list_blobs(self,**options):
            calls.append(options)
            clock[0]+=3
            return SimpleNamespace(pages=[[]],next_page_token='next' if len(calls)==1 else None)
    store=AtomicReplayCheckpoints(tmp_path,runner,{},Pages(),deadline=20,clock=lambda:clock[0])
    store.restore()
    assert [c['timeout'] for c in calls]==[10,7]
    assert [c['page_token'] for c in calls]==[None,'next']


def test_ambiguous_upload_retry_accepts_only_identical_immutable_bytes(tmp_path,monkeypatch):
    from services import atomic_replay_checkpoints as module
    from google.api_core.exceptions import ServiceUnavailable,PreconditionFailed
    runner=tmp_path/'runner';runner.write_text('kernel')
    monkeypatch.setattr(module.time,'sleep',lambda seconds:None)
    body=json.dumps({'replacement':1});name='a'*64+'.json.gz'
    raw=gzip.compress(json.dumps({'key':'a'*64,'body':body,'sha256':hashlib.sha256(body.encode()).hexdigest()}).encode())
    (tmp_path/name).write_bytes(raw)
    stored=[]
    class Blob:
        def upload_from_string(self,value,**options):
            assert options['if_generation_match']==0 and options['retry'] is None
            if not stored:stored.append(value);raise ServiceUnavailable('accepted but ACK lost')
            raise PreconditionFailed('already committed')
        def download_as_bytes(self,**options):return stored[0]
    class Remote:
        def blob(self,key):return Blob()
    store=AtomicReplayCheckpoints(tmp_path,runner,{},Remote(),deadline=200,clock=lambda:100)
    store.flush()
    assert stored==[raw] and name in store.uploaded


def test_flush_wait_never_becomes_an_unbounded_join(tmp_path):
    runner=tmp_path/'runner';runner.write_text('kernel');joined=[]
    class Thread:
        def join(self,timeout):joined.append(timeout)
        def is_alive(self):return True
    store=AtomicReplayCheckpoints(tmp_path,runner,{},deadline=100,clock=lambda:95)
    store.thread=Thread()
    with pytest.raises(AtomicReplayDeadlineExceeded,match='flush_deadline'):
        store.__exit__(None,None,None)
    assert joined==[5] and store.stop.is_set()
