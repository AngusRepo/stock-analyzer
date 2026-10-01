from copy import deepcopy
import gzip,json,pytest
from services.pipeline_sequence_transport import compact_sequence_subsets,expand_sequence_subsets,KEY
from services.pipeline_modal_request_transport import prepare_pipeline_modal_request
from test_pipeline_transport_capacity import _modal_request

def sample():
    p=_modal_request()
    p['sequence_series']=[{'symbol':str(i),'prices':[{'close':i+.123456789,'date':'2026-10-01'}]*128} for i in range(3)]
    p['sequence_model_series_by_model']={'TimeXer':deepcopy(p['sequence_series']),'PatchTST':deepcopy(p['sequence_series'][1:])}
    p['active8_shadow_sequence_series_by_model']={'TimeXer':deepcopy(p['sequence_series'][:1])}
    return p

def test_exact_roundtrip_membership_order_values_and_isolation():
    p=sample(); original=deepcopy(p)
    packed=compact_sequence_subsets(p)
    assert KEY in packed and p==original
    result=expand_sequence_subsets(json.loads(json.dumps(packed)))
    assert result==original
    result['sequence_model_series_by_model']['TimeXer'][0]['prices'][0]['close']=0
    assert result['sequence_series'][0]['prices'][0]['close']==original['sequence_series'][0]['prices'][0]['close']
    assert result['active8_shadow_sequence_series_by_model']['TimeXer'][0]['prices'][0]['close']!=0

def test_different_same_symbol_rows_never_silently_substituted():
    p=sample();p['sequence_model_series_by_model']['TimeXer'][0]['prices'][0]['close']=999
    assert compact_sequence_subsets(p)==p and KEY not in compact_sequence_subsets(p)

@pytest.mark.parametrize('bad',[[-1],[3],[True],[0,0],['0'],None])
def test_invalid_indices_fail_closed(bad):
    p=compact_sequence_subsets(sample());p[KEY]['fields']['sequence_model_series_by_model']['TimeXer']=bad
    with pytest.raises(ValueError,match='index_invalid'):expand_sequence_subsets(p)

def test_duplicate_wire_owners_fail_closed():
    p=compact_sequence_subsets(sample());p['sequence_model_series_by_model']={}
    with pytest.raises(ValueError,match='duplicate_owner'):expand_sequence_subsets(p)

def test_producer_keeps_caps_and_exact_logical_request_without_secrets():
    p=sample();encoded,ref=prepare_pipeline_modal_request(p)
    body=json.loads(gzip.decompress(encoded));assert KEY in body
    hydrated=expand_sequence_subsets(body)
    assert hydrated=={k:v for k,v in p.items() if k not in {'callback_url','callback_token'}}
    assert len(gzip.decompress(encoded))<len(json.dumps(p))*.7
    assert 'callback_token' not in body


def test_common_configuration_exact_roundtrip_and_mutation_isolation():
    p=sample()
    p['payloads']=[{'symbol':str(i),'trading_config':{'large':[i for i in range(200)]},'adaptive_params':{'specific':i}} for i in range(3)]
    before=deepcopy(p)
    encoded,ref=prepare_pipeline_modal_request(p)
    wire=json.loads(gzip.decompress(encoded))
    assert 'trading_config' not in wire['payloads'][0]
    assert wire['payloads'][0]['adaptive_params']=={'specific':0}
    restored=expand_sequence_subsets(wire)
    assert restored=={k:v for k,v in before.items() if k not in {'callback_url','callback_token'}} and p==before
    restored['payloads'][0]['trading_config']['large'][0]=999
    assert restored['payloads'][1]['trading_config']['large'][0]==0


def test_common_configuration_missing_or_different_stays_explicit():
    p=sample();p['payloads']=[{'symbol':'1','trading_config':{}},{'symbol':'2'}]
    assert expand_sequence_subsets(compact_sequence_subsets(p))==p
    assert 'payload_common_transport' not in compact_sequence_subsets(p)


@pytest.mark.parametrize('fault',['count','unknown','owner'])
def test_common_configuration_invalid_manifest_fails_closed(fault):
    p=sample();p['payloads']=[{'symbol':'1','trading_config':{}},{'symbol':'2','trading_config':{}}]
    packed=compact_sequence_subsets(p)
    if fault=='count':packed['payload_common_transport']['row_count']=999
    elif fault=='unknown':packed['payload_common_transport']['fields']['prices']=[]
    else:packed['payloads'][0]['trading_config']={}
    with pytest.raises(ValueError,match='pipeline_payload_common_'):expand_sequence_subsets(packed)
