from copy import deepcopy
import gzip
import json
import pytest
from test_premarket_pipeline import f
from services.pipeline_async_state_transport import (
    STATE_SCHEMA_V2, STATE_SCHEMA_V3, STATE_SCHEMA_V4, build_pipeline_payload_identity,
    encode_pipeline_state_envelope, decode_pipeline_state_envelope)

def envelope():
    history=[{'date':str(i),'close':100+i/10} for i in range(100)]
    rows=[{'symbol':s,'market_env':{'history':history,'stock_specific':i},'chips':[]} for i,s in enumerate(['A','B','C'])]
    rows[-1]['market_env']['history']=[{'close':999}]
    return {'schema_version':STATE_SCHEMA_V2,'state':{'payloads':rows,'market_env':{'regime':'neutral'},
            'pipeline_payload_identity':build_pipeline_payload_identity(rows)}}

def test_pool_missing_from_root_preserves_all_rows_and_unequal_histories():
    original=envelope();before=deepcopy(original)
    raw=encode_pipeline_state_envelope(original)
    wire=json.loads(gzip.decompress(raw))
    assert wire['schema_version']==STATE_SCHEMA_V4
    assert len(wire['payload_history_pool'])==1 and len(wire['payload_history_refs'])==2
    assert len(gzip.decompress(raw)) < len(json.dumps(original).encode())
    restored=decode_pipeline_state_envelope(raw)
    assert restored==before==original
    rows=restored['state']['payloads']
    assert rows[0]['market_env']['history'] is rows[1]['market_env']['history']
    assert rows[2]['market_env']['history']==[{'close':999}]
    assert 'history' not in restored['state']['market_env']

def test_distinct_equal_json_histories_are_pooled_after_legacy_restore():
    original=envelope()
    legacy=json.loads(json.dumps(original))
    assert legacy['state']['payloads'][0]['market_env']['history'] is not legacy['state']['payloads'][1]['market_env']['history']
    wire=json.loads(gzip.decompress(encode_pipeline_state_envelope(legacy)))
    assert wire['schema_version']==STATE_SCHEMA_V4
    assert decode_pipeline_state_envelope(gzip.compress(json.dumps(wire).encode()))==original

def test_v3_common_context_refs_compose_with_history_pool():
    original=envelope();config={'paper':True}
    original['state']['trading_config']=config
    for row in original['state']['payloads']:row['trading_config']=config
    raw=encode_pipeline_state_envelope(original)
    wire=json.loads(gzip.decompress(raw))
    assert wire['history_source_schema']==STATE_SCHEMA_V3
    restored=decode_pipeline_state_envelope(raw)
    assert restored==original
    assert restored['state']['payloads'][0]['trading_config'] is restored['state']['trading_config']

@pytest.mark.parametrize('fault',['content','duplicate','index','conflict','unused','source'])
def test_pool_tampering_is_rejected(fault):
    wire=json.loads(gzip.decompress(encode_pipeline_state_envelope(envelope())))
    if fault=='content':next(iter(wire['payload_history_pool'].values()))[0]['close']=-1
    elif fault=='duplicate':wire['payload_history_refs'].append(wire['payload_history_refs'][0])
    elif fault=='index':wire['payload_history_refs'][0]['index']=True
    elif fault=='conflict':wire['state']['payloads'][0]['market_env']['history']=[]
    elif fault=='unused':wire['payload_history_refs']=wire['payload_history_refs'][:1];wire['payload_history_pool']['0'*64]=[]
    elif fault=='source':wire['history_source_schema']='bad'
    with pytest.raises(ValueError,match='shared_history'):
        decode_pipeline_state_envelope(gzip.compress(json.dumps(wire).encode()))

def test_existing_root_history_uses_v3_and_unique_histories_keep_v2():
    original=envelope();original['state']['payloads']=original['state']['payloads'][:1]
    original['state']['pipeline_payload_identity']=build_pipeline_payload_identity(original['state']['payloads'])
    assert json.loads(gzip.decompress(encode_pipeline_state_envelope(original)))['schema_version']==STATE_SCHEMA_V2
    original['state']['market_env']=original['state']['payloads'][0]['market_env']
    raw=encode_pipeline_state_envelope(original)
    assert json.loads(gzip.decompress(raw))['schema_version']==STATE_SCHEMA_V3
    assert decode_pipeline_state_envelope(raw)==original


def test_postwrite_projection_accepts_v4_without_loading_payload_histories(f):
    import asyncio
    from services import premarket_pipeline as owner
    from test_premarket_pipeline import _research_input
    storage,state,_=f
    history=[{'close':i} for i in range(300)]
    state['payloads'][0]['market_env']={'history':history}
    state['payloads'].append({'symbol':'2454','market_env':{'history':history}})
    storage,state,context,receipt,path,uri=_research_input(f)
    blob=storage.blob(receipt['state_gcs_uri'].split('/'+storage.name+'/')[1])
    assert json.loads(gzip.decompress(blob.raw))['schema_version']==STATE_SCHEMA_V4
    async def node_compute_sector_flow(value):
        assert 'payloads' not in value and 'market_env' not in value
        return {'sector_flow_summary':{'status':'complete'}}
    result=asyncio.run(owner.resume(uri,nodes=[node_compute_sector_flow],merge=lambda s,u:s.update(u),
                                   client=storage,postwrite_only=True))
    assert result['sector_flow_summary']['status']=='complete'


@pytest.mark.parametrize('history', [[{1:'number','1':'last'}],[{1:'a',2:'b',10:'c'}]])
def test_legacy_numeric_key_history_keeps_original_normalization(history):
    value=envelope()
    value['state']['payloads']=value['state']['payloads'][:2]
    value['state']['pipeline_payload_identity']=build_pipeline_payload_identity(value['state']['payloads'])
    for row in value['state']['payloads']:row['market_env']['history']=history
    raw=encode_pipeline_state_envelope(value)
    assert json.loads(gzip.decompress(raw))['schema_version']==STATE_SCHEMA_V2
    assert decode_pipeline_state_envelope(raw)==json.loads(json.dumps(value))
