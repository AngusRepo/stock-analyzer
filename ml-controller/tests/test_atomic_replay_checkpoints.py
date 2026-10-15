import hashlib
import json
import gzip
import pytest
from services.atomic_replay_checkpoints import AtomicReplayCheckpoints

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
