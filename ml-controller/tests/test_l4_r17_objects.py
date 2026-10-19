"""Storage adapter tests include real immutable backend retry semantics."""
from datetime import datetime, timezone
import hashlib
import pytest
from test_l4_r17_native import SOURCE
from services.l4_r17_objects import R17Objects
from services.paired_nav_journal import digest
from google.api_core.exceptions import NotFound, PreconditionFailed


class Bucket:
    name='r17-unit-test-bucket'
    def __init__(self):self.rows={};self.reads=[]
    def blob(self,name):return Blob(self,name)


class Blob:
    def __init__(self,bucket,name):self.bucket,self.name=bucket,name
    def upload_from_string(self,raw,**kwargs):
        assert kwargs['if_generation_match']==0
        if self.name in self.bucket.rows:raise PreconditionFailed('immutable')
        self.bucket.rows[self.name]=raw
    def download_as_text(self):
        self.bucket.reads.append(self.name)
        if self.name not in self.bucket.rows:raise NotFound('missing')
        return self.bucket.rows[self.name]
    def reload(self):
        if self.name not in self.bucket.rows:raise NotFound('missing')
        self.time_created=datetime(2026,10,20,tzinfo=timezone.utc);self.generation=1


def test_backend_immutable_retry_header_and_server_receipt():
    bucket=Bucket();store=R17Objects(bucket)
    raw=''.join(f"INSERT INTO x VALUES({i},'original historical row');\n" for i in range(6000))
    state={'state_sql':raw,'state_checksum':hashlib.sha256(raw.encode()).hexdigest()}
    payload={'identity':{'kind':'frame','index':1},'states':{'A':state,'B':state}}
    ref=store.put(payload);key=digest(payload['identity'])
    assert store.publish_delivery(key,ref)==ref
    # A fresh process must verify an existing compact object, not accidentally
    # compare its expanded logical SQL against the compact retry payload.
    fresh=R17Objects(bucket)
    assert fresh.put(payload)==ref and fresh.publish_delivery(key,ref)==ref
    assert fresh.get(ref)==payload and fresh.verify_payload(ref,payload)
    bucket.reads.clear()
    assert set(fresh.get_header(ref)['states']['A'])=={'r17_state_ref'}
    assert bucket.reads==[ref]
    proof=fresh.receipt_clock(ref,key)
    assert proof['authority']=='object_store_server' and len(proof['objects'])==2
    bucket.rows[ref]=bucket.rows[ref].replace('"index":1','"index":2')
    with pytest.raises(ValueError,match='checksum'):fresh.get_header(ref)
