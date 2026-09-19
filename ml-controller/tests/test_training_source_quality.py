from routers import retrain_trigger as rt
from services import dataset_snapshots

def test_revenue_without_yoy_keeps_other_observed_fields():
    got=rt._snapshot_per_stock_ts_map(monthly_revenue_rows=[{'stock_id':1,'date':'2026-01','revenue_yoy':None,'revenue_mom':4.5,'revenue':120}],canonical_fundamental_rows=[],margin_rows=[],shareholding_rows=[],stock_ids=[1])
    assert got[1]['2026-02-12']=={'revenue_mom':4.5,'revenue':120}

def test_snapshot_preserves_available_technical_fields(monkeypatch):
    monkeypatch.setattr(dataset_snapshots,'latest_dataset_snapshot',lambda **k:{'snapshot_id':'local-test'})
    monkeypatch.setattr(rt,'_snapshot_component_uris',lambda s:{k:k for k in ['prices','indicators','chips']})
    sources={'prices':[{'stock_id':1,'date':'2026-01-01','open':10,'close':11}], 'chips':[],
             'indicators':[{'stock_id':1,'date':'2026-01-01','plus_di14':12,'minus_di14':4,'adx14':20,'parabolic_sar':9,'volume_momentum_divergence_13_27_10':.3}]}
    monkeypatch.setattr(rt,'_read_gcs_parquet_rows',lambda key:sources[key])
    maps=rt._load_training_maps_from_snapshot(stock_ids=[1],symbols=['TEST'],prices_lookback=504)
    row=maps[1][1][0]
    assert [row[k] for k in ['plusDi14','minusDi14','adx14','parabolicSar','volumeMomentumDivergence132710']]==[12,4,20,9,.3]


def test_compact_shareholding_date_is_normalized():
    got=rt._snapshot_per_stock_ts_map(monthly_revenue_rows=[],canonical_fundamental_rows=[],margin_rows=[],shareholding_rows=[{'stock_id':1,'date':'20260731','retail_pct':20,'created_at':'2026-08-02 10:40:24'}],stock_ids=[1])
    assert got[1]=={'2026-08-02':{'retail_pct':20}}


def test_shareholding_export_handles_both_date_formats_without_future_rows(monkeypatch):
    import sqlite3
    from services import dataset_snapshot_exporter as exporter
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.execute('CREATE TABLE shareholding(stock_id,date,total_shares,holder_count,retail_shares,retail_pct,large_holder_shares,large_holder_pct,created_at)')
    db.executemany("INSERT INTO shareholding VALUES (1,?,100,10,20,20,80,80,'2026-08-09 12:00:00')", [('20260731',),('2026-08-07',),('20260911',)])
    def query(sql,start,end,chunk_days,**kwargs):
        return [dict(r) for r in db.execute(sql,[start,end])],1
    monkeypatch.setattr(exporter,'_query_date_range',query)
    rows,_=exporter._query_shareholding('2026-07-01','2026-09-01',10)
    assert [r['date'] for r in rows]==['2026-07-31','2026-08-07']


def test_snapshot_broker_data_preserves_known_flow_and_excludes_late_reconstruction(monkeypatch):
    monkeypatch.setattr(dataset_snapshots,'latest_dataset_snapshot',lambda **k:{'snapshot_id':'local-test'})
    sources={'prices':[], 'indicators':[], 'chips':[], 'broker_flows':[
        {'symbol':'TEST','date':'2026-06-01','as_of_date':'2026-06-01','net_shares':10,'concentration':.2},
        {'symbol':'TEST','date':'2026-06-02','as_of_date':'2026-06-03','net_shares':999,'concentration':.9}]}
    monkeypatch.setattr(rt,'_snapshot_component_uris',lambda s:{k:k for k in sources})
    monkeypatch.setattr(rt,'_read_gcs_parquet_rows',lambda key:sources[key])
    maps=rt._load_training_maps_from_snapshot(stock_ids=[1],symbols=['TEST'],prices_lookback=504)
    assert len(maps[2]['TEST'])==1
    assert maps[2]['TEST'][0]['broker_net_shares']==10
    assert maps[2]['TEST'][0]['broker_concentration']==.2


def test_shareholding_without_availability_is_not_backdated():
    got=rt._snapshot_per_stock_ts_map(monthly_revenue_rows=[],canonical_fundamental_rows=[],margin_rows=[],
        shareholding_rows=[{'stock_id':1,'date':'20260731','retail_pct':20}],stock_ids=[1])
    assert got=={}


def test_shareholding_availability_rolls_utc_to_taipei_and_orders_observations():
    from services.training_calendar import shareholding_available_date
    assert shareholding_available_date({'date':'20260731','created_at':'2026-08-02T20:00:00Z'})=='2026-08-03'
    rows=[{'stock_id':1,'date':'20260807','retail_pct':30,'created_at':'2026-08-09 00:00:00'},
          {'stock_id':1,'date':'20260731','retail_pct':20,'created_at':'2026-08-09 00:00:00'}]
    got=rt._snapshot_per_stock_ts_map(monthly_revenue_rows=[],canonical_fundamental_rows=[],margin_rows=[],
        shareholding_rows=rows,stock_ids=[1])
    assert got[1]=={'2026-08-09':{'retail_pct':30}}
