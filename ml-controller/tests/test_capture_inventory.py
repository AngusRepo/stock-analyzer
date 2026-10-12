import asyncio
import hashlib
import json
from types import SimpleNamespace

import pytest

from services.capture_inventory import inspect_capture_inventory
from services.training_auxiliary_capture import FIELDS


class Bucket:
    name = 'test'

    def __init__(self):
        self.store = {}

    def blob(self, name):
        return SimpleNamespace(name=name, exists=lambda: name in self.store,
            download_as_bytes=lambda: self.store[name],
            download_as_text=lambda: self.store[name].decode())

    def list_blobs(self, prefix):
        return [self.blob(name) for name in self.store if name.startswith(prefix)]

    def put(self, name, obj):
        self.store[name] = json.dumps(obj).encode()


def fixture():
    b = Bucket()
    root = 'daily/raw'
    day = '2026-10-12'
    sha = 'a' * 64
    price_fields = ('open','high','low','close','volume','value','adj_close','adj_open','market_value')
    institution_fields = ('foreign_net','trust_net','dealer_self_net','dealer_hedge_net')
    for folder, fields, schema in (
        ('daily_price_full_vintage',price_fields,'finlab-adjusted-price-single-capture-v1'),
        ('chip_diversity_full_vintage',institution_fields,'finlab-institutional-single-capture-v1'),
        ('training_auxiliary_full_vintage',FIELDS,'finlab-training-auxiliary-single-capture-v1')):
        m = {'schema_version':schema,'capture_id':'daily','end_date':day,'start_date':'2023-10-12',
             'checksums':{f:sha for f in fields},
             'fields':{f:{'sha256':sha,'start_date':'2023-10-12'} for f in fields}}
        b.put(f'{root}/{folder}/manifest.json',m)
        for f in fields: b.store[f'{root}/{folder}/{f}.parquet'] = b'presence-only-fixture'
    for name in ('broker','holding'):
        b.put(f'{root}/training_long_full_vintage/{name}.json',
              {'schema_version':'training-long-source-capture-v1','capture_id':'daily','end':day,'source':name,'sha256':sha})
        b.store[f'{root}/training_long_full_vintage/{name}.parquet'] = b'presence-only-fixture'
    for name in ('training_calendar.json','training_breadth.json'):
        b.put(f'{root}/daily_price_full_vintage/{name}',{})
    seq = {'status':'ready','output_gcs_prefix':'seq','lane_reports':[{'lane':'daily_price','source_uri':
           {'capture_id':'daily','close':f'gs://test/{root}/daily_price_full_vintage/close.parquet',
            'checksums':{'adj_close':sha,'adj_open':sha}}}]}
    seq['manifest_checksum'] = hashlib.sha256(json.dumps(seq,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    b.put('seq/prep/sequence_manifest.json',seq)
    return b


def inspect(b):
    return inspect_capture_inventory(b,sequence_gcs_prefix='seq',run_date='2026-10-12')


@pytest.mark.parametrize('filename',['close.parquet','adj_close.parquet'])
def test_inventory_pass_is_not_value_or_model_admission(filename):
    b=fixture();path='seq/prep/sequence_manifest.json';seq=json.loads(b.store[path])
    seq['lane_reports'][0]['source_uri']['close']='gs://test/daily/raw/daily_price_full_vintage/'+filename
    unsigned={k:v for k,v in seq.items() if k!='manifest_checksum'}
    seq['manifest_checksum']=hashlib.sha256(json.dumps(unsigned,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    b.put(path,seq)
    report = inspect(b)
    assert report['status'] == 'inventory_ready'
    assert report['issues'] == []
    assert report['value_validation_complete'] is False
    assert report['model_admitted'] is False


def test_collects_all_missing_sources_and_short_daily_history_together():
    b = fixture()
    aux = 'daily/raw/training_auxiliary_full_vintage'
    m = json.loads(b.store[aux+'/manifest.json'])
    for field in FIELDS:
        if field not in ('margin_balance','short_balance'):
            del m['fields'][field]
            del b.store[f'{aux}/{field}.parquet']
        else: m['fields'][field]['start_date'] = '2026-10-12'
    b.put(aux+'/manifest.json',m)
    for name in ('broker','holding'):
        del b.store[f'daily/raw/training_long_full_vintage/{name}.json']
        del b.store[f'daily/raw/training_long_full_vintage/{name}.parquet']
    report = inspect(b)
    assert report['status'] == 'blocked'
    assert sum(x['code']=='object_missing' for x in report['issues']) == 11
    assert sum(x['code']=='manifest_missing' for x in report['issues']) == 2
    assert sum(x['code']=='daily_history_starts_after_price_capture' for x in report['issues']) == 2


def test_wrong_identity_and_malformed_manifest_do_not_hide_other_gaps():
    b=fixture();path='daily/raw/training_auxiliary_full_vintage/manifest.json'
    b.store[path]=b'broken json'
    path='daily/raw/training_long_full_vintage/broker.json'
    m=json.loads(b.store[path]);m['capture_id']='different';m['end']='2026-10-08';b.put(path,m)
    del b.store['daily/raw/training_long_full_vintage/holding.parquet']
    codes={x['code'] for x in inspect(b)['issues']}
    assert {'manifest_invalid_json','capture_identity_mismatch','capture_date_mismatch','object_missing'} <= codes


def test_unsealed_sequence_rejected():
    b=fixture();s=json.loads(b.store['seq/prep/sequence_manifest.json']);s['status']='failed'
    b.put('seq/prep/sequence_manifest.json',s)
    with pytest.raises(ValueError,match='training_source_manifest_invalid'):
        inspect(b)


@pytest.mark.parametrize('tamper',[False,True])
def test_legacy_price_start_is_verified_from_actual_date_column(tamper):
    import io
    import polars as pl
    b=fixture();root='daily/raw/daily_price_full_vintage';path=root+'/manifest.json'
    m=json.loads(b.store[path]);m.pop('start_date')
    out=io.BytesIO();pl.DataFrame({'date':['2023-10-12','2026-10-12'],'2330':[10.,11.]}).write_parquet(out)
    raw=out.getvalue();m['checksums']['close']=hashlib.sha256(raw).hexdigest();b.put(path,m)
    b.store[root+'/close.parquet']=raw+(b'tamper' if tamper else b'')
    path='daily/raw/training_auxiliary_full_vintage/manifest.json';m=json.loads(b.store[path])
    m['fields']['margin_balance']['start_date']='2026-10-12';b.put(path,m)
    issues=inspect(b)['issues']
    expected='price_calendar_content_checksum_mismatch' if tamper else 'daily_history_starts_after_price_capture'
    assert any(x['code']==expected for x in issues)


def test_route_rejects_before_lock_stock_load_and_modal(monkeypatch):
    from routers import retrain_trigger as route
    from google.cloud import storage
    b=fixture();del b.store['daily/raw/training_long_full_vintage/holding.parquet']
    monkeypatch.setattr(storage,'Client',lambda: SimpleNamespace(bucket=lambda _:b))
    monkeypatch.setattr(route,'_verified_prep_only_receipt',lambda *a,**kw:None)
    def forbidden(*a,**kw): raise AssertionError('must not start work with incomplete source inventory')
    monkeypatch.setattr(route.retrain_lock,'acquire',forbidden)
    monkeypatch.setattr(route,'_training_stock_rows',forbidden)
    monkeypatch.setattr(route,'load_market_env',forbidden)
    req=route.UniversalRetrainTriggerRequest(run_date='2026-10-12',prep_only=True,
        prep_output_gcs_prefix='universal/oof_forward_prep_v2/test',sequence_gcs_prefix='seq',train_model_groups=[])
    result=asyncio.run(route.trigger_universal_retrain(req,request=None))
    assert result['error']=='prep_source_inventory_incomplete'
    assert result['source_inventory']['issues'][0]['path'].endswith('holding.parquet')
