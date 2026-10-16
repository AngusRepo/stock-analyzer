"""Lossless transport, native decoding and complete dependency-aware owner replay."""
from copy import deepcopy
import gzip
import io
import json
import math
import pickle
import pytest
from services import streaming_json_reader as reader
from services.pipeline_async_state_transport import (
    STATE_SCHEMA_V2, STATE_SCHEMA_V3, build_pipeline_payload_identity,
    encode_pipeline_state_envelope, decode_pipeline_state_envelope,
)
from services.paired_nav_read_cache import reuse_verified_cold_reads
from test_paired_nav_lifecycle import environment, registered_old, stamp
from test_premarket_pipeline import f


@pytest.mark.parametrize('raw', [b'{"x":-0.0,"y":1e-400}',
    b'{"x":18446744073709551616,"y":1e308}', b'{"x":1,"x":2}',
    b'\xef\xbb\xbf'+br'{"name":"\u53f0\u7063"}', b'[true,null,1.5]', b'123'])
def test_native_builder_numeric_fallback_and_copy_pickle(raw):
    value=reader.load(io.BytesIO(raw))
    expected=json.loads(raw.decode('utf-8-sig'))
    assert json.dumps(value)==json.dumps(expected)
    assert deepcopy(value)==value and pickle.loads(pickle.dumps(value))==value
    if isinstance(value,dict) and value.get('x')==0:
        assert math.copysign(1,value['x'])==-1


@pytest.mark.parametrize('raw',[b'{} {}',b'{} garbage',b'{"x":NaN}',b'{"x":'])
def test_native_builder_exhausts_full_input(raw):
    with pytest.raises(Exception):reader.load(io.BytesIO(raw))


def packet():
    common={'rates':list(range(1000)),'revenue':None}
    config={'fees':{'commission':.001425},'model':list(range(500))}
    rows=[{'symbol':'A','market_env':common,'trading_config':config},
          {'symbol':'B','market_env':{**common,'revenue':2},'trading_config':config},
          {'symbol':'C','market_env':{'rates':[9]},'trading_config':{'fees':{'commission':.002}}}]
    state={'payloads':rows,'market_env':common,'trading_config':config,
           'pipeline_payload_identity':build_pipeline_payload_identity(rows)}
    return {'schema_version':STATE_SCHEMA_V2,'state':state}


def test_context_reference_round_trip_preserves_overrides_and_does_not_mutate_inputs():
    value=packet();before=deepcopy(value)
    raw=encode_pipeline_state_envelope(value);wire=json.loads(gzip.decompress(raw))
    assert wire['schema_version']==STATE_SCHEMA_V3
    assert 'trading_config' not in wire['state']['payloads'][0]
    assert wire['state']['payloads'][1]['market_env']=={'revenue':2}
    restored=decode_pipeline_state_envelope(raw)
    assert restored==before==value
    state=restored['state'];rows=state['payloads']
    assert rows[0]['trading_config'] is state['trading_config']
    assert rows[1]['market_env']['rates'] is state['market_env']['rates']
    assert rows[2]['trading_config']['fees']['commission']==.002


@pytest.mark.parametrize('mutation',['override','duplicate','out_of_range','unknown_field','bad_source'])
def test_context_reference_tampering_rejected(mutation):
    wire=json.loads(gzip.decompress(encode_pipeline_state_envelope(packet())))
    ref=wire['payload_context_refs'][0]
    if mutation=='override':wire['state']['payloads'][0]['trading_config']={}
    elif mutation=='duplicate':wire['payload_context_refs'].append(ref)
    elif mutation=='out_of_range':ref['index']=999
    elif mutation=='unknown_field':ref['fields'].append('arbitrary')
    elif mutation=='bad_source':wire['source_schema']='invented'
    with pytest.raises(ValueError,match='shared_context'):
        decode_pipeline_state_envelope(gzip.compress(json.dumps(wire).encode()))


def test_whole_journal_owner_replay_reuses_fusion_only_after_fresh_dependencies(environment,monkeypatch):
    from services import paired_nav_comparison as comparison
    from services.paired_nav_evidence import read_verified_nav_evidence
    db,*_=environment;registered_old(environment)
    original=comparison._resolve_allocation_comparison;calls=[]
    def counted(**kwargs):
        calls.append(kwargs['allocation']['payload']['content']['owner'])
        return original(**kwargs)
    monkeypatch.setattr(comparison,'_resolve_allocation_comparison',counted)
    outputs=[]
    with reuse_verified_cold_reads():
        for _ in range(4):
            outputs.append(read_verified_nav_evidence(business_date='2026-09-08',query=db.query,
                now=stamp('2026-09-11')).summary())
    assert all(value==outputs[0] for value in outputs)
    assert calls.count('allocator_ev_fusion')==1 and calls.count('l4_alpha_ev')==1
    # Scope expiry must execute original validators again.
    read_verified_nav_evidence(business_date='2026-09-08',query=db.query,now=stamp('2026-09-11'))
    assert calls.count('allocator_ev_fusion')>1


def test_changed_or_new_dependency_never_reuses_old_comparison():
    from services.paired_nav_read_cache import ComparisonReads,remember_comparison,reusable_comparison
    rows=[];manifest={'snapshot_id':'parent','payload_checksum':'same'}
    def query(sql,params):return [dict(manifest)] if 'frozen_manifests' in sql else deepcopy(rows)
    allocation={'payload':{'content':{'owner':'atomic_strategy'}}}
    with reuse_verified_cold_reads():
        recorded=ComparisonReads(query);recorded('SELECT * FROM child',[])
        remember_comparison(query,allocation,{'manifest':manifest},{'ok':True},dependencies=list(recorded.reads.values()))
        assert reusable_comparison(query,allocation)=={'ok':True}
        rows.append({'id':'newly_arrived_source'})
        assert reusable_comparison(query,allocation) is None


def test_known_read_adapters_share_bytes_but_execution_filter_remains_live(monkeypatch):
    from services.paired_nav_read_cache import query_cache_identity,ComparisonReads
    from services.daily_nav_read_receipt import RecordedClient
    from services.strategy_nav_read_model import DisplayRecordedClient
    from services.strategy_nav_accounting_scope import StrategyAccountingScope
    from services.d1_domain_client import DomainD1Client,D1DataDomain
    import services.d1_domain_client as domain
    monkeypatch.setattr(domain,'database_id_for_domain',lambda *a,**kw:'same-learning-db')
    direct=DomainD1Client(D1DataDomain.LEARNING)
    scope=StrategyAccountingScope(RecordedClient(direct).query,('atomic_strategy',))
    identities=[query_cache_identity(query) for query in (
        direct.query,scope.query,ComparisonReads(scope.query),DisplayRecordedClient(direct).query)]
    assert len(set(identities))==1
    assert query_cache_identity(StrategyAccountingScope(lambda *a:[],('atomic_strategy',)).query)!=identities[0]


def test_caller_supplied_parent_identity_is_not_ignored_by_reuse():
    from services.paired_nav_read_cache import remember_comparison,reusable_comparison
    manifest={'snapshot_id':'parent','payload_checksum':'original'}
    allocation={'payload':{'content':{'owner':'ensemble'}}}
    def query(*args):return [manifest]
    with reuse_verified_cold_reads():
        remember_comparison(query,allocation,{'manifest':manifest},{'ok':True})
        assert reusable_comparison(query,allocation,parent_manifest={**manifest,'payload_checksum':'forged'}) is None


def test_shared_byte_identity_does_not_hide_active_execution_gaps():
    from services.strategy_nav_accounting_scope import StrategyAccountingScope
    from services.paired_nav_journal import mature_staged_pairs
    from test_strategy_nav_accounting_scope import DB,seal,NOW
    db=DB();seal(db,'ensemble',token='a')
    scope=StrategyAccountingScope(db.query,('atomic_strategy',))
    with reuse_verified_cold_reads():
        assert mature_staged_pairs(business_date='2026-09-09',query=scope.query,
            writer=db.writer,now=NOW)['recorded_pair_sessions']==0
        with pytest.raises(RuntimeError,match='due_execution_receipt_missing'):
            mature_staged_pairs(business_date='2026-09-09',query=db.query,writer=db.writer,now=NOW)
        _,active=seal(db,'atomic_strategy',token='b')
        with pytest.raises(RuntimeError,match='due_execution_receipt_missing:'+active['snapshot_id']):
            mature_staged_pairs(business_date='2026-09-09',query=scope.query,writer=db.writer,now=NOW)


def test_postwrite_streaming_accepts_new_wire_without_materializing_histories(f):
    import asyncio
    from services import premarket_pipeline as owner
    from test_premarket_pipeline import _research_input
    storage,state,_=f
    state['market_env']={'macro':list(range(3000))}
    state['payloads'][0]['market_env']=state['market_env']
    storage,state,context,receipt,path,uri=_research_input(f)
    blob=storage.blob(receipt['state_gcs_uri'].split('/'+storage.name+'/')[1])
    assert json.loads(gzip.decompress(blob.raw))['schema_version']==STATE_SCHEMA_V3
    assert owner.load_state(receipt,client=storage)['payloads']==state['payloads']
    async def node_compute_sector_flow(value):
        assert 'payloads' not in value and 'market_env' not in value
        return {'sector_flow_summary':{'status':'complete'}}
    result=asyncio.run(owner.resume(uri,nodes=[node_compute_sector_flow],merge=lambda s,u:s.update(u),
                                   client=storage,postwrite_only=True))
    assert result['sector_flow_summary']['status']=='complete'
