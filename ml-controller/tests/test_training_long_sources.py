import io,json,hashlib
import polars as pl
import pytest
from services.training_long_sources import bind_long_sources,write_broker_capture,write_holding_capture

def attach_long(bucket,price):
    root=price["capture_manifest_path"].rsplit("/daily_price_full_vintage/",1)[0]+"/training_long_full_vintage";proof={"schema_version":"training-long-source-binding-v1","capture_id":price["capture_id"]}
    frames={"broker":pl.DataFrame({"date":["2026-09-28","2026-09-29"],"symbol":["3004","3004"],"broker_net_lots":[4.,5.],"broker_concentration":[.2,.25],"broker_count":[3,4]}),
        "holding":pl.DataFrame({"date":["2026-09-25"],"symbol":["3004"],"retail_pct":[35.]})}
    for name,frame in frames.items():
        b=io.BytesIO();frame.write_parquet(b);raw=b.getvalue();bucket.data[root+"/"+name+".parquet"]=raw
        meta={"schema_version":"training-long-source-capture-v1","source":name,"capture_id":price["capture_id"],"end":"2026-09-29","rows":frame.height,"columns":frame.columns,"sha256":hashlib.sha256(raw).hexdigest()}
        raw=json.dumps(meta).encode();path=root+"/"+name+".json";bucket.data[path]=raw;proof[name]={**meta,"manifest_path":path,"manifest_sha256":hashlib.sha256(raw).hexdigest()}
    return proof

def test_current_observation_does_not_backdate_history():
    from test_training_market_cap_capture import setup
    bucket,prices,price=setup();attach_long(bucket,price)
    dated,chips,proof=bind_long_sources(bucket,price_capture=price,stock_rows=[{"id":1,"symbol":"3004"}],prices_map=prices,
        prior_ts={1:{"2026-09-28":{"eps":3.}}},prior_chips={"3004":[{"date":"2026-09-28","dealer_net":1.}]},run_date="2026-09-29")
    assert "retail_pct" not in dated[1]["2026-09-28"]
    assert dated[1]["2026-09-29"]["retail_pct"]==35.
    assert "broker_net_shares" not in chips["3004"][0]
    assert chips["3004"][1]["broker_net_shares"]==5.
    assert proof["historical_holding_rows_without_publication_attestation"]==1

def test_broker_native_units_and_ties(tmp_path):
    f=pl.DataFrame({"date":["2026-09-28"]*2,"symbol":["3004"]*2,"broker":["b","a"],"buy":[2.,0.],"sell":[0.,2.]})
    r=write_broker_capture(f,run_dir=tmp_path,start="2026-09-01",end="2026-09-29")
    out=pl.read_parquet(tmp_path/"raw/training_long_full_vintage/broker.parquet")
    assert out["broker_net_lots"][0]==-2. and out["broker_count"][0]==2
    assert out["broker_concentration"][0]==.5


def test_broker_capture_bounded_windows_preserve_duplicate_branch_ties(tmp_path, monkeypatch):
    from datetime import date, timedelta
    from collections import defaultdict
    from services import training_long_sources as module
    rows=[]
    for offset in range(20):
        day=(date(2026,9,1)+timedelta(days=offset)).isoformat()
        for symbol in ['0050','2330']:
            rows.extend([{'date':day,'symbol':symbol,'broker':broker,'buy':buy,'sell':sell}
                         for broker,buy,sell in [('a',0.,2.),('a',0.,2.),('b',4.,0.),('c',1.,1.)]])
    original=module._aggregate_broker_window;observed=[]
    def bounded(frame):
        dates=frame.select('date').unique().collect()['date'].to_list()
        assert (date.fromisoformat(max(dates))-date.fromisoformat(min(dates))).days<=6
        observed.extend(dates)
        return original(frame)
    monkeypatch.setattr(module,'_aggregate_broker_window',bounded)
    receipt=module.write_broker_capture(pl.DataFrame(rows).lazy(),run_dir=tmp_path,start='2026-09-02',end='2026-09-19')
    actual=pl.read_parquet(tmp_path/'raw/training_long_full_vintage/broker.parquet').to_dicts()
    branches=defaultdict(lambda:[0.,0.])
    for r in rows:
        if '2026-09-02'<=r['date']<='2026-09-19':
            v=branches[r['symbol'],r['date'],r['broker']];v[0]+=r['buy'];v[1]+=r['sell']
    grouped=defaultdict(list)
    for (symbol,day,broker),(buy,sell) in branches.items():grouped[symbol,day].append((broker,buy,sell))
    assert receipt['rows']==36 and len(observed)==len(set(observed))==18
    for r in actual:
        items=grouped[r['symbol'],r['date']];winner=sorted(items,key=lambda v:(-abs(v[1]-v[2]),v[0]))[0]
        buy=sum(v[1] for v in items);sell=sum(v[2] for v in items);net=winner[1]-winner[2]
        assert r['broker_net_lots']==net and r['dominant_abs_lots']==abs(net)
        assert r['buy_lots']==buy and r['sell_lots']==sell and r['broker_count']==len(items)
        assert r['broker_concentration']==abs(net)/max(abs(buy)+abs(sell),1)


def test_broker_empty_partition_does_not_fill_missing_dates(tmp_path):
    f=pl.DataFrame({'date':['2026-09-01','2026-09-30'],'symbol':['2330']*2,'broker':['a']*2,'buy':[0.,2.],'sell':[0.,0.]})
    r=write_broker_capture(f,run_dir=tmp_path,start='2026-09-01',end='2026-09-30')
    out=pl.read_parquet(tmp_path/'raw/training_long_full_vintage/broker.parquet')
    assert r['rows']==2 and out['date'].to_list()==['2026-09-01','2026-09-30']
    assert out['broker_net_lots'].to_list()==[0.,2.]
