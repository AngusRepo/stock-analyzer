"""Canonical artifact identity must survive faster token batching unchanged."""
import gzip
import hashlib
import json
import math
import random
import struct
from datetime import date

import pytest

from services.paired_nav_journal import digest
from services.paired_nav_cold import _canonical, packed
from services.pipeline_json_transport import iter_json_bytes


def reference(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


@pytest.mark.parametrize('value',[
    {'中文 α 😀':'quote"\\\n','records':[{'v':i/7,'b':-0.0} for i in range(97)]},
    {2:'two',1:'one'},[[],{},('tuple',1)],{'big':2**150,'tiny':1e-320},
    {'shared':[{'history':[{'date':str(i),'v':i/17} for i in range(80)]}]*65},
])
def test_strict_bytes_digest_and_cold_payload_identity(value):
    raw=reference(value);sha=hashlib.sha256(raw).hexdigest()
    assert b''.join(iter_json_bytes(value,sort_keys=True,allow_nan=False,default=None))==raw
    assert digest(value)==sha
    with packed(_canonical(value)) as (path,checksum,size,_parts):
        with gzip.open(path,'rb') as source:assert source.read()==raw
        assert checksum==sha and size==len(raw)


def test_random_finite_float_bits_and_mutation_isolation():
    rng=random.Random(20261016)
    values=[struct.unpack('d',rng.randbytes(8))[0] for _ in range(3000)]
    value={'values':[v for v in values if math.isfinite(v)]}
    before=reference(value)
    assert digest(value)==hashlib.sha256(before).hexdigest()
    assert reference(value)==before
    value['values'][0]=42
    assert digest(value)!=hashlib.sha256(before).hexdigest()


@pytest.mark.parametrize('value',[float('nan'),float('inf'),-float('inf'),
    {'rows':[{'v':float('nan')}]},{'rows':[date(2026,10,15)]},object()])
def test_canonical_rejects_nonfinite_and_unsupported_values(value):
    with pytest.raises((ValueError,TypeError)):digest(value)
    with pytest.raises((ValueError,TypeError)):list(_canonical(value))


def test_cycles_are_rejected_and_legacy_transport_defaults_stay_unchanged():
    cycle={'rows':[]};cycle['rows'].append(cycle)
    with pytest.raises(ValueError,match='Circular reference'):digest(cycle)
    value={'nan':float('nan'),'date':date(2026,10,15)}
    assert b''.join(iter_json_bytes(value))==json.dumps(value,ensure_ascii=False,separators=(',',':'),default=str).encode()


NESTED={'by_date':{f'2026-09-{d:02d}':{'arms':{arm:{'nav':1+d/97,'fills':[{'symbol':str(2330+i),'qty':i}
    for i in range(d%5)]} for arm in ('a','b')}} for d in range(1,31)},'中文':[{},[],{'z':None}],'int_keys':{2:'b',1:'a'}}


@pytest.mark.parametrize('limit',[1,3,40,4096])
@pytest.mark.parametrize('value',[NESTED,{2:'two',1:'one'},{'rows':[{'v':i/7} for i in range(5000)]},[[{'a':[1,2]}]*7]])
def test_inline_subtrees_keep_exact_canonical_bytes(value,limit):
    raw=b''.join(iter_json_bytes(value,sort_keys=True,allow_nan=False,default=None,inline_nodes=limit))
    assert raw==reference(value)


def test_inline_bound_keeps_large_payloads_streamed_and_rejections():
    pieces=list(iter_json_bytes({'rows':list(range(5000))},inline_nodes=4096))
    assert len(pieces)>3 and max(map(len,pieces))<1000
    cycle={'rows':[]};cycle['rows'].append(cycle)
    with pytest.raises(ValueError,match='Circular reference'):b''.join(iter_json_bytes(cycle,inline_nodes=4096))
    with pytest.raises(ValueError):digest({'small':[float('inf')]})
