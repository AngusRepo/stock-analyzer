import copy, hashlib, json
import polars as pl
import pytest
from services.training_stock_roster import select_training_stock_rows
from services.training_snapshot_integrity import REQUIRED_COMPONENTS, verify_component_file

def sample():
    return [dict(id=1,symbol='0050',market='TWSE',listed_date=None,delisted_date=None),
            dict(id=2,symbol='009801',market='OTC',listed_date='2026-01-01',delisted_date=None),
            dict(id=3,symbol='7000',market='ROTC',listed_date=None,delisted_date=None),
            dict(id=4,symbol='1230',market='TWSE',listed_date=None,delisted_date='2001-11-01'),
            dict(id=5,symbol='5555',market='OTC',listed_date=None,delisted_date='2026-08-01')]
def select(rows):return select_training_stock_rows(rows,start_date='2023-04-06',end_date='2026-10-08')

def test_in_window_retired_and_unknown_start_kept_without_survivorship_filter():
    assert [r['symbol'] for r in select(sample())]==['0050','009801','5555']
@pytest.mark.parametrize('fault',['duplicate_id','duplicate_symbol','invalid_date','reversed_date','unknown_venue','bad_id','blank_symbol'])
def test_bad_roster_refused(fault):
    rows=sample()
    if fault=='duplicate_id':rows[1]['id']=1
    if fault=='duplicate_symbol':rows[1]['symbol']='0050'
    if fault=='invalid_date':rows[1]['listed_date']='2026/01/01'
    if fault=='reversed_date':rows[1]['delisted_date']='2025-01-01'
    if fault=='unknown_venue':rows[1]['market']='OTHER'
    if fault=='bad_id':rows[1]['id']=True
    if fault=='blank_symbol':rows[1]['symbol']=' 0050'
    with pytest.raises(ValueError):select(rows)
def test_inclusive_window_edges_and_future_listing():
    rows=sample();rows[0]['delisted_date']='2023-04-06';rows[1]['listed_date']='2026-10-08'
    assert len(select(rows))==3
    rows[1]['listed_date']='2026-10-09';assert len(select(rows))==2

def fixture(tmp_path):
    path=tmp_path/'stocks.parquet';frame=pl.DataFrame(sample());frame.write_parquet(path)
    components={n:dict(name=n,row_count=1,gcs_uri='gs://bucket/run/'+n+'.parquet',columns=['x'],bytes=1,content_checksum='sha256:'+'0'*64) for n in REQUIRED_COMPONENTS}
    components['stocks']=dict(name='stocks',row_count=frame.height,gcs_uri='gs://bucket/run/stocks.parquet',columns=frame.columns,bytes=path.stat().st_size,content_checksum='sha256:'+hashlib.sha256(path.read_bytes()).hexdigest())
    metadata=dict(start_date='2023-04-06',end_date='2026-10-08',component_meta=components,components={k:v['gcs_uri'] for k,v in components.items()})
    snap=dict(kind='backtest_dataset',business_date='2026-10-08',row_count=sum(v['row_count'] for v in components.values()),gcs_uri='gs://bucket/run',metadata_json=json.dumps(metadata))
    payload={k:snap[k] for k in ('kind','business_date','row_count')};payload.update({k:metadata[k] for k in ('start_date','end_date','component_meta')})
    snap['checksum']='sha256:'+hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return snap,path

def install(monkeypatch,snap,path):
    from routers import retrain_trigger as rt
    from services import dataset_snapshots
    monkeypatch.setattr(dataset_snapshots,'latest_dataset_snapshot',lambda **kw:snap)
    class NoLive:
        def query(self,*a,**k):raise AssertionError('mutable_live_roster_read')
    monkeypatch.setattr(rt,'CORE_D1_CLIENT',NoLive())
    def read(uri,*,integrity_meta=None):
        assert uri.endswith('/stocks.parquet')
        yield from verify_component_file(path,integrity_meta).iter_rows(named=True)
    monkeypatch.setattr(rt,'_read_gcs_parquet_rows',read)
    return rt

def test_actual_prep_selector_uses_verified_snapshot_and_no_live_query(tmp_path,monkeypatch):
    from services.formal_feature_contract import PROFILES131
    snap,path=fixture(tmp_path);rt=install(monkeypatch,snap,path)
    expected=select_training_stock_rows(sample(),start_date='2023-04-06',end_date='2026-10-08',with_listed_date=True)
    for profile in PROFILES131:
        req=rt.UniversalRetrainTriggerRequest(run_date='2026-10-08',prep_only=True,model_profile_schema_version=profile)
        assert rt._training_stock_rows(req)==expected
    req=rt.UniversalRetrainTriggerRequest(run_date='2026-10-08',prep_only=True,limit=1)
    assert rt._training_stock_rows(req)==expected[:1]

@pytest.mark.parametrize('fault',['corrupt_stock_bytes','wrong_date','bad_envelope'])
def test_real_prep_selector_rejects_before_live_db(tmp_path,monkeypatch,fault):
    snap,path=fixture(tmp_path);rt=install(monkeypatch,snap,path)
    if fault=='corrupt_stock_bytes':path.write_bytes(path.read_bytes()+b'corrupt')
    if fault=='bad_envelope':snap['checksum']='sha256:'+'0'*64
    req=rt.UniversalRetrainTriggerRequest(run_date='2026-10-07' if fault=='wrong_date' else '2026-10-08',prep_only=True)
    with pytest.raises(ValueError):rt._training_stock_rows(req)

def test_second_snapshot_read_rejects_changed_owner_before_loading_prices(tmp_path,monkeypatch):
    snap,path=fixture(tmp_path);rt=install(monkeypatch,snap,path)
    with pytest.raises(ValueError,match='snapshot_identity_changed'):
        rt._load_training_maps_from_snapshot(stock_ids=[1],symbols=['009801'],prices_lookback=1280,as_of_business_date='2026-10-08',verify_source=True)

def test_full_pool_rejects_added_owner_in_second_snapshot(tmp_path,monkeypatch):
    snap,path=fixture(tmp_path);rt=install(monkeypatch,snap,path)
    with pytest.raises(ValueError,match='snapshot_identity_changed'):
        rt._load_training_maps_from_snapshot(stock_ids=[1],symbols=['0050'],prices_lookback=1280,as_of_business_date='2026-10-08',verify_source=True,require_full_stock_roster=True)

@pytest.mark.parametrize('kind',['price','institutional'])
def test_numeric_vintage_respects_explicit_window(tmp_path,monkeypatch,kind):
    import pandas as pd
    from test_finlab_remote_backfill_tool_contract import _load_tool_module
    tool=_load_tool_module()
    monkeypatch.setattr(tool,'start_date_for_years',lambda y:'2026-01-01')
    frame=pd.DataFrame({'0050':[1.,2.,3.]},index=pd.DatetimeIndex(['2025-12-30','2026-01-02','2026-01-05'],name='date'))
    fields=['adj_open','adj_close','close'] if kind=='price' else ['foreign_net','trust_net','dealer_self_net','dealer_hedge_net']
    fn=tool.write_adjusted_price_vintage if kind=='price' else tool.write_institutional_vintage
    fn({f:frame for f in fields},run_dir=tmp_path,years=1,start_date='2025-12-30',end_date='2026-01-02')
    folder='daily_price_full_vintage' if kind=='price' else 'chip_diversity_full_vintage'
    got=pd.read_parquet(tmp_path/'raw'/folder/(fields[0]+'.parquet'))
    assert list(got.index)==list(frame.index[:2]) and got['0050'].tolist()==[1.,2.]

@pytest.mark.parametrize('value',['2026-1-1','2026-10-09','not-a-date'])
def test_invalid_full_history_start_precedes_no_external_calls(tmp_path,value):
    from test_finlab_remote_backfill_tool_contract import _load_tool_module
    tool=_load_tool_module()
    with pytest.raises(ValueError,match='training_capture_start_invalid'):
        tool.materialize_specs(years=3,run_dir=tmp_path,source_start_date='2026-10-08',source_end_date='2026-10-08',training_capture_start_date=value)
    assert list(tmp_path.iterdir())==[]


def test_selected_rows_carry_listing_date_for_label_venue():
    rows=select_training_stock_rows(sample(),start_date='2023-04-06',end_date='2026-10-08',with_listed_date=True)
    assert {r['symbol']:r['listed_date'] for r in rows}=={'0050':None,'009801':'2026-01-01','5555':None}
    # Other callers (L4 native roster checksums) keep the base row shape.
    assert all(set(r)=={'id','symbol','market'} for r in select(sample()))


class _SidecarBucket:
    name='stockvision-models'
    def __init__(self,files):self.files=files
    def blob(self,name):
        files=self.files
        class Blob:
            def exists(self):return name in files
            def download_as_bytes(self):return files[name]
            def download_as_text(self):return files[name].decode()
            def __getattr__(self,attr):raise AssertionError('sidecar_wrote:'+attr)
        return Blob()

def _parquet(frame):
    import io
    buf=io.BytesIO();frame.write_parquet(buf);return buf.getvalue()

def _sidecar_store(tamper=False):
    days=['2026-01-02','2026-01-05','2026-01-06','2026-01-07']
    close=pl.DataFrame({'date':days,'2330':[1.,2,3,4],'1234':[5.,6,None,None],'5678':[7.,None,None,None],
                        '9999':[8.,9,None,None],'4321':[1.,None,None,None],'1111':[2.,None,None,None],
                        '00631L':[3.,None,None,None],'0050':[4.,None,None,None],'2222':[6.,None,None,None],
                        '7777':[5.,5,None,None],'8888':[5.,None,None,None]})
    price,chip='cap/raw/daily_price_full_vintage','cap/raw/chip_diversity_full_vintage'
    fields={f:close for f in ('open','high','low','close','volume','value','adj_open')}
    fields['value']=close.drop('8888')  # one price field lacks the symbol's column
    fields['adj_close']=close.with_columns(pl.when(pl.col('date')=='2026-01-05').then(None).otherwise(pl.col('7777')).alias('7777'))
    files={f'{price}/{f}.parquet':_parquet(frame) for f,frame in fields.items()}
    flows=('foreign_net','trust_net','dealer_self_net','dealer_hedge_net')
    flow=pl.DataFrame({'date':days,**{s:[0.]*4 for s in ('2330','1234','4321','9999','7777','8888')}})
    files.update({f'{chip}/{f}.parquet':_parquet(flow) for f in flows})
    files[price+'/manifest.json']=json.dumps({'capture_id':'cap','checksums':{f:hashlib.sha256(files[f'{price}/{f}.parquet']).hexdigest() for f in fields}}).encode()
    chip_sums={f:hashlib.sha256(files[f'{chip}/{f}.parquet']).hexdigest() for f in flows}
    if tamper:chip_sums['trust_net']='0'*64
    files[chip+'/manifest.json']=json.dumps({'checksums':chip_sums}).encode()
    seq={'status':'ready','output_gcs_prefix':'seq','lane_reports':[{'lane':'daily_price','source_uri':{'close':'gs://stockvision-models/'+price+'/close.parquet'}}]}
    seq['manifest_checksum']=hashlib.sha256(json.dumps(seq,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    files['seq/prep/sequence_manifest.json']=json.dumps(seq).encode()
    return files

def _core(sql,params):
    assert sql.lstrip().upper().startswith('SELECT'),sql
    core={'1234':[dict(id=11,symbol='1234',market='TWSE',listed_date='2010-01-01',delisted_date='2026-01-06')],
          '9999':[dict(id=12,symbol='9999',market='OTC',listed_date=None,delisted_date=None)],
          '4321':[dict(id=13,symbol='4321',market='ROTC',listed_date=None,delisted_date='2026-01-03')],
          '1111':[dict(id=14,symbol='1111',market='TWSE',listed_date=None,delisted_date='2026-01-03')],
          '2222':[dict(id=15,symbol='2222',market='TWSE',listed_date=None,delisted_date='2026-01-03')]*2,
          '7777':[dict(id=16,symbol='7777',market='TWSE',listed_date=None,delisted_date='2026-01-06')],
          '8888':[dict(id=17,symbol='8888',market='OTC',listed_date=None,delisted_date='2026-01-03')]}
    return [r for s in params for r in core.get(s,[])]

def test_capture_sidecar_admits_stopped_commons_from_capture_only():
    from services.training_stock_roster import capture_sidecar_rows
    roster=[dict(id=1,symbol='2330',market='TWSE')]
    rows,proof=capture_sidecar_rows(_SidecarBucket(_sidecar_store()),sequence_gcs_prefix='seq',stock_rows=roster,
                                    run_date='2026-01-07',query_fn=_core)
    assert rows==[{'id':11,'symbol':'1234','market':'TWSE','listed_date':'2010-01-01'}]
    # 00631L and 0050 are not 4-digit commons; 2222 has two core rows.
    # Every symbol the price/institutional loaders would abort on stays out, recorded.
    assert proof['excluded']=={'2222':'core_identity_ambiguous','1111':'institutional_columns_missing',
                               '4321':'venue_not_tw','5678':'core_identity_missing','9999':'delisted_date_missing',
                               '7777':'adjustment_incomplete','8888':'price_columns_missing'}
    assert proof['admitted']==['1234'] and proof['admitted_symbol_days']==2 and proof['stopped_commons_absent_from_snapshot']==8
    assert proof['core_identity']==[dict(id=11,symbol='1234',market='TWSE',listed_date='2010-01-01',delisted_date='2026-01-06')]
    assert proof['d1_writes']==0 and proof['capture_writes']==0 and proof['capture_id']=='cap'
    with pytest.raises(ValueError,match='training_sidecar_checksum_mismatch:trust_net'):
        capture_sidecar_rows(_SidecarBucket(_sidecar_store(tamper=True)),sequence_gcs_prefix='seq',stock_rows=roster,
                             run_date='2026-01-07',query_fn=_core)
