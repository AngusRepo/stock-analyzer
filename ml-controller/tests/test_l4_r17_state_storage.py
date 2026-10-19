import hashlib
from copy import deepcopy
import pytest
from test_l4_r17_native import Objects
from services.l4_r17_state_storage import ReferencedStates


class Store(ReferencedStates,Objects):pass


def state(value):return {'state_sql':value,'state_checksum':hashlib.sha256(value.encode()).hexdigest()}


def test_receipts_deduplicate_states_and_headers_never_materialize_sql():
    store=Store();initial=state('original sql')
    payload={'identity':{'kind':'frame'},'states':{a:deepcopy(initial) for a in ('A','B','C','L')}}
    ref=store.put(payload)
    assert store.get(ref)==payload and len(store.data)==2
    header=store.get_header(ref)
    assert all(set(s)=={'r17_state_ref'} for s in header['states'].values())
    checkpoint={'identity':{'kind':'arm'},**initial,'output':{'frames':[]}}
    assert store.get(store.put(checkpoint))==checkpoint
    bootstrap={'state':initial,'account':{'cash':1}}
    assert store.get(store.put(bootstrap))==bootstrap
    assert len([v for v in store.data.values() if 'state_sql' in v])==1


def test_referenced_state_corruption_is_rejected():
    store=Store();ref=store.put({'states':{'A':state('original')}})
    child=store.get_header(ref)['states']['A']['r17_state_ref']
    store.data[child]['state_sql']='corrupted'
    with pytest.raises(ValueError,match='checksum'):store.get(ref)
    with pytest.raises(ValueError,match='checksum'):store.put({'states':{'A':{'state_sql':'x','state_checksum':'bad'}}})


def test_large_sql_chunks_preserve_every_byte_and_reuse_unchanged_history():
    store=Store()
    raw=''.join(f"INSERT INTO audit VALUES({i},'original unchanged historical row');\n" for i in range(6000))
    first=store.put({'states':{'A':state(raw)}})
    assert store.get(first)['states']['A']==state(raw)
    first_manifest=store.data[store.get_header(first)['states']['A']['r17_state_ref']]
    assert first_manifest['schema']=='r17-sql-chunks-v1'
    changed=raw.replace("VALUES(10,", "VALUES(100000,",1)
    second=store.put({'states':{'A':state(changed)}})
    second_manifest=store.data[store.get_header(second)['states']['A']['r17_state_ref']]
    assert store.get(second)['states']['A']==state(changed)
    assert len(set(first_manifest['chunks'])&set(second_manifest['chunks']))>=len(first_manifest['chunks'])-2
