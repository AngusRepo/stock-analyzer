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

    def list_blobs(self, prefix, match_glob=None):
        import fnmatch
        return [self.blob(name) for name in self.store if name.startswith(prefix)
                and (match_glob is None or fnmatch.fnmatchcase(name, match_glob))]

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


# R33 per_field_auxiliary: each field from its own latest content-addressed capture.
def _full_aux(b, capture, end, fields, sha='b' * 64, start='2023-01-03'):
    root = f'daily/{capture}/raw/training_auxiliary_full_vintage'
    b.put(root + '/manifest.json', {'schema_version': 'finlab-training-auxiliary-single-capture-v1', 'capture_id': capture,
                                   'end_date': end, 'fields': {f: {'sha256': sha, 'start_date': start} for f in fields}})
    for f in fields:
        b.store[f'{root}/{f}.parquet'] = b'presence-only-fixture'
    return root


def _daily_only(b):
    aux = 'daily/raw/training_auxiliary_full_vintage'
    m = json.loads(b.store[aux + '/manifest.json'])
    m['fields'] = {f: v for f, v in m['fields'].items() if f in ('margin_balance', 'short_balance', 'pe', 'pb')}
    b.put(aux + '/manifest.json', m)


def per_field(b):
    return inspect_capture_inventory(b, sequence_gcs_prefix='seq', run_date='2026-10-12', per_field_auxiliary=True)


def test_per_field_inventory_binds_missing_fields_from_older_full_capture():
    b = fixture(); _daily_only(b); _full_aux(b, 'full', '2026-10-09', FIELDS)
    assert inspect(b)['status'] == 'blocked'  # v1 same-root contract still requires all 11 fields
    report = per_field(b)
    assert report['status'] == 'inventory_ready', report['issues']
    owners = {k: v['capture_id'] for k, v in report['auxiliary_field_captures'].items()}
    assert owners['margin_balance'] == owners['pe'] == 'daily'
    assert owners['revenue'] == owners['dividend_yield'] == 'full'


def test_per_field_inventory_blocks_corrupt_latest_sha_missing_object_and_short_daily_history():
    b = fixture(); _daily_only(b); _full_aux(b, 'full', '2026-10-09', FIELDS)
    _full_aux(b, 'newer', '2026-10-11', ('revenue',), sha='not-a-sha')
    report = per_field(b)
    assert report['status'] == 'blocked'
    assert [x['detail'] for x in report['issues'] if x['code'] == 'auxiliary_field_capture_unresolved'] == [
        'root_auxiliary_field_checksum_invalid:revenue']

    b = fixture(); _daily_only(b); root = _full_aux(b, 'full', '2026-10-09', FIELDS, start='2024-01-02')
    del b.store[root + '/eps.parquet']
    codes = [(x['code'], x['path'].rsplit('/', 1)[1]) for x in per_field(b)['issues']]
    assert ('object_missing', 'eps.parquet') in codes
    assert ('daily_history_starts_after_price_capture', 'dividend_yield.parquet') in codes
    assert not any(c == 'daily_history_starts_after_price_capture' and f != 'dividend_yield.parquet' for c, f in codes)



# R33 require_aligned_history: institutional and market_value must start with the price vintage.
GUARD_DAYS = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']


def _wide(days, value=1.0, symbols=120):
    import io
    import polars as pl
    buffer = io.BytesIO()
    pl.DataFrame({'date': days, **{f's{i}': [value] * len(days) for i in range(symbols)}}).write_parquet(buffer)
    return buffer.getvalue()


def _seal_real(b, folder, field, raw):
    root = f'daily/raw/{folder}'
    b.store[f'{root}/{field}.parquet'] = raw
    m = json.loads(b.store[root + '/manifest.json'])
    m['checksums'][field] = hashlib.sha256(raw).hexdigest()
    b.put(root + '/manifest.json', m)


def _seal_broker(b, days, symbols=120):
    import io
    import polars as pl
    buffer = io.BytesIO()
    pl.DataFrame({'date': [d for d in days for _ in range(symbols)], 'symbol': [f's{i}' for _ in days for i in range(symbols)],
                  'broker_net_lots': [1.0] * (len(days) * symbols)}).write_parquet(buffer)
    raw = buffer.getvalue(); root = 'daily/raw/training_long_full_vintage'
    b.store[root + '/broker.parquet'] = raw
    meta = json.loads(b.store[root + '/broker.json']); meta['sha256'] = hashlib.sha256(raw).hexdigest()
    b.put(root + '/broker.json', meta)


def guarded_fixture(*, mv_days=GUARD_DAYS, inst_days=GUARD_DAYS, mv_value=1.0, broker_days=GUARD_DAYS, broker_symbols=120):
    b = fixture()
    _seal_broker(b, broker_days, broker_symbols)
    _seal_real(b, 'daily_price_full_vintage', 'close', _wide(GUARD_DAYS))
    _seal_real(b, 'daily_price_full_vintage', 'market_value', _wide(mv_days, mv_value))
    for field in ('foreign_net', 'trust_net', 'dealer_self_net', 'dealer_hedge_net'):
        _seal_real(b, 'chip_diversity_full_vintage', field, _wide(inst_days if field == 'foreign_net' else GUARD_DAYS, 0.0))
    return b


def guarded(b, **flags):
    return inspect_capture_inventory(b, sequence_gcs_prefix='seq', run_date='2026-10-12', **flags)


def test_aligned_sources_pass_r33_history_guard():
    report = guarded(guarded_fixture(), require_aligned_history=True)
    assert report['status'] == 'inventory_ready', report['issues']


def test_late_institutional_history_blocks_r33_before_loading():
    report = guarded(guarded_fixture(inst_days=GUARD_DAYS[2:]), require_aligned_history=True)
    issue = [x for x in report['issues'] if x['code'].startswith('r33_source_history_starts_after_price')]
    assert report['status'] == 'blocked'
    assert issue == [{'code': 'r33_source_history_starts_after_price:foreign_net',
                      'path': 'daily/raw/chip_diversity_full_vintage/foreign_net.parquet',
                      'source': 'foreign_net', 'source_start': '2026-10-08', 'price_start': '2026-10-06'}]


@pytest.mark.parametrize('kwargs', [{'mv_days': GUARD_DAYS[1:]}, {'mv_value': float('nan')}])
def test_late_or_empty_market_value_blocks_r33(kwargs):
    report = guarded(guarded_fixture(**kwargs), require_aligned_history=True)
    codes = [x['code'] for x in report['issues']]
    assert report['status'] == 'blocked' and codes == ['r33_source_history_starts_after_price:market_value']


def test_non_r33_inventory_ignores_history_alignment():
    b = guarded_fixture(inst_days=GUARD_DAYS[2:], mv_days=GUARD_DAYS[1:])
    assert guarded(b)['status'] == 'inventory_ready'
    assert guarded(b, per_field_auxiliary=False)['status'] == 'inventory_ready'


@pytest.mark.parametrize('kwargs', [{'broker_days': GUARD_DAYS[3:]}, {'broker_symbols': 99}])
def test_late_or_thin_broker_history_blocks_r33(kwargs):
    report = guarded(guarded_fixture(**kwargs), require_aligned_history=True)
    issues = [x for x in report['issues'] if x['code'].startswith('r33_source_history_starts_after_price')]
    assert report['status'] == 'blocked'
    assert [(x['code'], x['source'], x['price_start']) for x in issues] == [
        ('r33_source_history_starts_after_price:broker', 'broker', '2026-10-06')]
    assert issues[0]['source_start'] == ('2026-10-09' if 'broker_days' in kwargs else None)


def test_non_r33_ignores_late_broker_history():
    assert guarded(guarded_fixture(broker_days=GUARD_DAYS[3:]))['status'] == 'inventory_ready'

