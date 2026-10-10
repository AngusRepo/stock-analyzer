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
    for profile in PROFILES131:
        req=rt.UniversalRetrainTriggerRequest(run_date='2026-10-08',prep_only=True,model_profile_schema_version=profile)
        assert rt._training_stock_rows(req)==select(sample())
    req=rt.UniversalRetrainTriggerRequest(run_date='2026-10-08',prep_only=True,limit=1)
    assert rt._training_stock_rows(req)==select(sample())[:1]

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
