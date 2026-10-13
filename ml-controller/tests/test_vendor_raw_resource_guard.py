from collections import OrderedDict
from datetime import datetime, timedelta, timezone
import importlib
import io
import json
import pandas as pd
import pytest
from services.vendor_raw_resource_guard import bounded_download, capture_one, preflight, probe_quota
from services.vendor_raw_capture import FullRawCapture


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    import requests
    def blocked(*args, **kw): raise AssertionError('unexpected_network')
    monkeypatch.setattr(requests.sessions.Session, 'request', blocked)
    monkeypatch.setattr('urllib.request.urlopen', blocked)


def quota(**changes):
    return dict({'observed_at': datetime.now(timezone.utc).isoformat(),
                 'used_mb': 4780.5, 'limit_mb': 5000,
                 'unexpected_download_payload': False}, **changes)


def gate(q=None, **changes):
    return preflight(q or quota(), **dict({'max_wire_bytes': 100,
        'quota_reserve_mb': 200, 'free_bytes': 1000, 'disk_floor_bytes': 700}, **changes))


def test_resource_boundary():
    assert gate()['status'] == 'resource_preflight_passed_not_source_admission'
    assert not gate()['quota_billing_bound_proven']


@pytest.mark.parametrize('q,kwargs,error', [
    ({}, {'quota_reserve_mb': 220}, 'quota_headroom_insufficient'),
    ({}, {'free_bytes': 999}, 'disk_headroom_insufficient'),
    ({'used_mb': float('nan')}, {}, 'quota_values_invalid'),
    ({'limit_mb': 0}, {}, 'quota_values_invalid'),
    ({'used_mb': True}, {}, 'quota_values_invalid'),
    ({'unexpected_download_payload': True}, {}, 'quota_probe_unexpected_payload'),
    ({'observed_at': (datetime.now(timezone.utc)-timedelta(seconds=90)).isoformat()}, {}, 'quota_observation_stale_or_future'),
    ({'observed_at': (datetime.now(timezone.utc)+timedelta(minutes=10)).isoformat()}, {}, 'quota_observation_stale_or_future'),
    ({'observed_at': '2026-10-09T01:00:00'}, {}, 'quota_timestamp_naive'),
    ({}, {'max_wire_bytes': -1}, 'resource_bounds_invalid'),
])
def test_no_dispatch_invalid_resource(q, kwargs, error):
    with pytest.raises(ValueError, match=error): gate(quota(**q), **kwargs)


class Response:
    def __init__(self, chunks, headers=None):
        self.chunks=chunks; self.headers=headers or {}; self.closed=False; self.iterated=0
    def __enter__(self): return self
    def __exit__(self, *args): self.closed=True
    def raise_for_status(self): pass
    def iter_content(self, **kwargs):
        for chunk in self.chunks:
            self.iterated+=1
            yield chunk


def transfer(response, **changes):
    return bounded_download('https://unused.invalid/raw', {}, **dict({
        'max_wire_bytes': 4, 'disk_root': '.', 'disk_floor_bytes': 10,
        'request_get': lambda *a, **k: response, 'free_space': lambda: 100}, **changes))


@pytest.mark.parametrize('headers', [{}, {'content-length': '4'}])
def test_bounded_wire_exact(headers):
    r=Response([b'ab', b'cd'], headers)
    assert transfer(r)==b'abcd' and r.closed


@pytest.mark.parametrize('chunks,headers,error', [
    ([b'abcde'], {'content-length': '5'}, 'content_length_outside_bound'),
    ([b'abc', b'de'], {}, 'wire_bound_exceeded'),
    ([b'abc'], {'content-length': '4'}, 'wire_payload_incomplete'),
    ([b'abc'], {'content-length': '-1'}, 'content_length_invalid'),
    ([b'abc'], {'content-encoding': 'gzip'}, 'encoded_wire_size_not_supported'),
    ([], {}, 'wire_payload_incomplete'),
])
def test_failed_wire_never_returns_partial(chunks, headers, error):
    r=Response(chunks, headers)
    with pytest.raises(ValueError, match=error): transfer(r)
    assert r.closed


def test_disk_loss_midstream():
    checks=iter([100,100,21]); r=Response([b'ab',b'cd'])
    with pytest.raises(ValueError,match='disk_headroom_lost'):transfer(r,free_space=lambda:next(checks))
    assert r.closed


def test_probe_official_time_saved_no_secrets_in_output(monkeypatch):
    import finlab.auth
    monkeypatch.setattr(finlab.auth,'get_id_token',lambda:'secret-token-fixture')
    monkeypatch.setattr(finlab.auth,'get_session',lambda:{'session_id':'secret-session-fixture'})
    seen=[]
    class JsonResponse(Response):
        def read(self,limit):return json.dumps({'results':[{'quota':4,'limit_size':5000,'time_scheduled':'20261012073200'}]}).encode()
    def send(req,**kwargs):
        p=json.loads(req.data);seen.append(p)
        assert p['items'][0]['time_saved'] and p['items'][0]['blob_name'].endswith('.recent.feather')
        return JsonResponse([])
    monkeypatch.setattr('urllib.request.urlopen',send)
    out=probe_quota()
    assert len(seen)==1 and out['data_downloads']==0 and out['remaining_mb']==4996
    assert 'secret' not in json.dumps(out)


@pytest.mark.parametrize('bad_raw', [False,True])
def test_true_sdk_get_persistence_and_raw_conflict_gate(tmp_path,monkeypatch,bad_raw):
    cap=FullRawCapture(tmp_path/'fresh',roster=['0050'],required={'close':'price:收盤價'})
    cap.make_sdk_storage()  # Safely initialize SDK's process singleton.
    from finlab import data
    get=importlib.import_module('finlab.data.get'); auth=importlib.import_module('finlab.data.auth')
    original=auth._download_feather_bytes; storage=data._storage
    raw=pd.DataFrame({'date':pd.to_datetime(['2026-10-07']), '0050 A':[0.0],
        '0050 B':[1.0 if bad_raw else 0.0], '9999 Extra':[3.0]})
    buf=io.BytesIO();raw.to_feather(buf);payload=buf.getvalue()
    calls=[]
    def metadata(requests):
        calls.append(list(requests))
        return OrderedDict([('price:收盤價',auth.FetchMetadata(
            expiry=datetime(2030,1,1,tzinfo=timezone.utc),url='https://unused.invalid/raw',role='vip'))])
    monkeypatch.setattr(get,'fetch_metadata_batch',metadata)
    response=Response([payload],{'content-length':str(len(payload))})
    kwargs=dict(max_wire_bytes=len(payload),quota_reserve_mb=100,disk_floor_bytes=10,
        quota_provider=lambda:quota(),request_get=lambda *a,**k:response,free_space=lambda:10**9)
    if bad_raw:
        with pytest.raises(ValueError,match='raw_alias_conflict'): capture_one(cap,'close',**kwargs)
        assert cap.receipt['status']=='rejected'
    else:
        capture_one(cap,'close',**kwargs)
        assert cap.finish()['status']=='raw_complete_not_formal_admitted'
    assert calls==[['price:收盤價']] and response.closed
    assert (cap.root/'sealed/close.feather').read_bytes()==payload
    assert auth._download_feather_bytes is original and data._storage is storage


def test_preflight_blocks_before_actual_sdk_or_network(tmp_path):
    cap=FullRawCapture(tmp_path/'fresh',roster=['0050'],required={'close':'price:收盤價'})
    with pytest.raises(ValueError,match='quota_headroom_insufficient'):
        capture_one(cap,'close',max_wire_bytes=10,quota_reserve_mb=220,disk_floor_bytes=10,
                    quota_provider=lambda:quota(),free_space=lambda:1000)
    assert not list((cap.root/'sdk').iterdir()) and not cap.receipt['datasets']


def test_actual_sdk_oversize_rejects_and_cannot_retry(tmp_path,monkeypatch):
    cap=FullRawCapture(tmp_path/'fresh',roster=['0050'],required={'close':'price:收盤價'})
    cap.make_sdk_storage()
    get=importlib.import_module('finlab.data.get'); auth=importlib.import_module('finlab.data.auth')
    monkeypatch.setattr(get,'fetch_metadata_batch',lambda request:OrderedDict([
        ('price:收盤價',auth.FetchMetadata(expiry=datetime(2030,1,1,tzinfo=timezone.utc),
        url='https://unused.invalid/raw',role='vip'))]))
    response=Response([b'oversize'],{'content-length':'8'})
    kw=dict(max_wire_bytes=4,quota_reserve_mb=100,disk_floor_bytes=10,
            quota_provider=lambda:quota(),request_get=lambda *a,**k:response,free_space=lambda:1000)
    with pytest.raises(ValueError,match='content_length_outside_bound'): capture_one(cap,'close',**kw)
    assert response.closed and response.iterated==0 and cap.receipt['status']=='rejected'
    assert not list((cap.root/'sdk').glob('*.feather'))
    assert not list((cap.root/'sealed').iterdir())
    with pytest.raises(ValueError,match='capture_closed_or_field_already_sealed'):capture_one(cap,'close',**kw)
