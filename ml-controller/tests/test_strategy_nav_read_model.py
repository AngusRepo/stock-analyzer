from copy import deepcopy
from datetime import datetime, timezone
import json
from types import SimpleNamespace
import pytest
from services import strategy_nav_read_model as model

NOW=datetime(2026,9,29,0,tzinfo=timezone.utc)
DAY='2026-09-28'
class Client:
    def __init__(self): self.rows=[{'id':1,'checksum':'original'}];self.calls=0
    def query(self,sql,params=None): self.calls+=1;return deepcopy(self.rows)
class Store:
    def __init__(self):self.data={}
    def read(self,key):return json.loads(self.data[key]) if key in self.data else None
    def write(self,key,raw):self.data[key]=raw
    def publish_latest(self,receipt):
        pointer=model._pointer(receipt);key=model._latest_key(receipt['code_identity'])
        old=self.read(key)
        if old is None or (old['business_date'],old['evaluated_at'])<(pointer['business_date'],pointer['evaluated_at']):
            self.write(key,json.dumps(pointer).encode())

@pytest.fixture
def setup(monkeypatch):
    client,store,builds=Client(),Store(),[]
    monkeypatch.setattr(model,'code_identity',lambda:'exact-code')
    def build(*,business_date,query,now):
        builds.append(1);query('SELECT * FROM original ORDER BY id',[])
        return {'as_of_date':business_date,'observed_at':now.isoformat(),'entries':[]}
    monkeypatch.setattr(model,'read_all_strategy_nav_evidence',build)
    return client,store,builds

def read(client,store,**kw):
    return model.read_strategy_nav_read_model(strategy_id='s8',strategy_version='v1',
        business_date=DAY,client=client,store=store,now=NOW,**kw)

def build(client,store):
    return model.refresh_strategy_nav_read_model(business_date=DAY,client=client,store=store,now=NOW)

def test_all_strategy_reads_share_original_producer_and_recheck_source(setup):
    client,store,builds=setup
    assert build(client,store)['status']=='published'
    for _ in range(4):
        result=read(client,store)
        assert result['status']=='not_registered' and result['promotion_allowed'] is False
        assert result['observed_at']==NOW.isoformat()
    assert build(client,store)['original_payload_reads']==0
    assert len(builds)==1 and client.calls>=6
    client.rows[0]['checksum']='corrected_same_count'
    with pytest.raises(ValueError,match='source_changed'):read(client,store)
    assert len(builds)==1 # HTTP never falls through to original data on stale/missing.
    assert build(client,store)['status']=='published' and len(builds)==2

@pytest.mark.parametrize('mutation',['new_row','deleted_row','missing','tampered','code_change','future_clock'])
def test_invalid_display_is_not_empty_or_stale_success(setup,monkeypatch,mutation):
    client,store,builds=setup;build(client,store)
    key=next(iter(store.data));doc=json.loads(store.data[key])
    if mutation=='new_row':client.rows.append({'id':2})
    if mutation=='deleted_row':client.rows=[]
    if mutation=='missing':store.data.clear()
    if mutation=='tampered':
        doc['evidence']['entries'].append({'status':'available'});store.data[key]=json.dumps(doc).encode()
    if mutation=='code_change':monkeypatch.setattr(model,'code_identity',lambda:'different-code')
    if mutation=='future_clock':
        doc['evidence']['observed_at']='2099-01-01T00:00:00+00:00'
        doc['evidence_checksum']=model._digest(doc['evidence']);store.data[key]=json.dumps(doc).encode()
    with pytest.raises(ValueError):read(client,store)
    assert len(builds)==1

def test_source_mutation_during_original_verification_blocks_publication(setup,monkeypatch):
    client,store,_=setup
    def changed(**kw):
        kw['query']('SELECT * FROM original',[]);client.rows=[]
        return {'as_of_date':DAY,'observed_at':NOW.isoformat(),'entries':[]}
    monkeypatch.setattr(model,'read_all_strategy_nav_evidence',changed)
    with pytest.raises(ValueError,match='source_changed'):build(client,store)
    assert not store.data

def test_unverified_provider_failure_is_not_persisted_as_stable_failure(setup,monkeypatch):
    client,store,_=setup
    def failed(**kw):
        kw['query']('SELECT * FROM original',[])
        return {'as_of_date':DAY,'observed_at':NOW.isoformat(),
                'entries':[{'status':'unavailable','error':'nav_policy_original_evidence_unavailable'}]}
    monkeypatch.setattr(model,'read_all_strategy_nav_evidence',failed)
    with pytest.raises(ValueError,match='original_unverified'):build(client,store)
    assert not store.data

def test_unbounded_hot_dependency_cannot_make_http_reader_expensive(setup):
    client,store,_=setup;client.rows=[{'raw':'x'*(model.MAX_RECEIPT_BYTES+1)}]
    with pytest.raises(ValueError,match='dependency_too_large'):build(client,store)
    assert not store.data


def test_midnight_displays_original_completed_cutoff_without_relabelling(setup):
    client,store,_=setup;build(client,store)
    result=model.read_strategy_nav_read_model(strategy_id='s8',strategy_version='v1',
        business_date='2026-09-29',client=client,store=store,now=NOW)
    assert result['as_of_date']==DAY and result['read_model']['is_prior_business_date'] is True
    assert result['read_model']['requested_as_of_date']=='2026-09-29'
    client.rows.append({'id':2})
    with pytest.raises(ValueError,match='source_changed'):
        model.read_strategy_nav_read_model(strategy_id='s8',strategy_version='v1',
            business_date='2026-09-29',client=client,store=store,now=NOW)


def test_current_index_cannot_supply_future_evidence_to_earlier_request(setup):
    client,store,_=setup;build(client,store)
    with pytest.raises(ValueError,match='missing'):
        model.read_strategy_nav_read_model(strategy_id='s8',strategy_version='v1',
            business_date='2026-09-27',client=client,store=store,now=NOW)


def test_producer_refuses_writes_before_calling_original_database(setup):
    client,_,_=setup
    with pytest.raises(ValueError,match='read_only'):
        model.DisplayRecordedClient(client).query('DELETE FROM original')
    assert client.calls==0


def test_gcs_latest_pointer_cas_never_overwrites_a_newer_replay(setup):
    from google.api_core.exceptions import PreconditionFailed
    client,memory,_=setup;build(client,memory)
    receipt=next(json.loads(v) for v in memory.data.values() if 'evidence' in json.loads(v))
    proposed=model._pointer(receipt)
    class Blob:
        size=300;generation=1;uploads=0
        prior={**proposed,'business_date':'2026-09-27','key':'older'}
        def reload(self):pass
        def download_as_bytes(self,**kw):return json.dumps(self.prior).encode()
        def upload_from_string(self,raw,**kw):
            assert kw['if_generation_match']==1
            self.uploads+=1;self.generation=2
            self.prior={**proposed,'business_date':'2026-09-29','key':'newer'}
            raise PreconditionFailed('fixture concurrent publication')
    blob=Blob();store=model.StrategyNavReceiptStore(SimpleNamespace(blob=lambda key:blob))
    store.publish_latest(receipt)
    assert blob.uploads==1 and blob.prior['business_date']=='2026-09-29'


def test_index_conflict_on_reused_receipt_does_not_repeat_original_downloads(setup,monkeypatch):
    client,store,builds=setup;build(client,store)
    def conflict(receipt):raise ValueError('strategy_nav_read_model_index_concurrent_update')
    monkeypatch.setattr(store,'publish_latest',conflict)
    with pytest.raises(ValueError,match='concurrent_update'):build(client,store)
    assert len(builds)==1


def test_actual_controller_display_batches_all_original_dependency_checks(setup, monkeypatch):
    from routers import paired_nav
    from services import d1_client, d1_domain_client
    client, store, _ = setup
    build(client, store)
    for key, raw in list(store.data.items()):
        receipt = json.loads(raw)
        if 'evidence' not in receipt:
            continue
        receipt['reads'] = [{'sql': 'SELECT ? AS i', 'params': [i],
            'checksum': model._digest([{'i': i}])} for i in range(53)]
        receipt['reads_checksum'] = model._digest(receipt['reads'])
        store.data[key] = json.dumps(receipt)
    batches = []
    def forbidden(*args, **kwargs):
        raise AssertionError('display_dependency_queries_must_be_batched')
    def batch(statements, *, database_id):
        assert database_id == 'fixture-learning'
        batches.append(len(statements))
        return [[{'i': statement['params'][0]}] for statement in statements]
    monkeypatch.setattr(d1_domain_client, 'database_id_for_domain', lambda domain, require_specific=False: 'fixture-learning')
    monkeypatch.setattr(d1_domain_client.DomainD1Client, 'query', forbidden)
    monkeypatch.setattr(d1_client, 'read_raw_batch', batch)
    monkeypatch.setattr(paired_nav, 'production_read_store', lambda: store)
    result = paired_nav._read_strategy_display({'strategy_id': 's8', 'strategy_version': 'v1',
        'business_date': DAY}, NOW)
    assert result['read_model']['source_read_count'] == 53
    assert batches == [25, 25, 3]
