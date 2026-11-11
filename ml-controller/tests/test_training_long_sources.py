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


class _DataBucket:
    """Plain object store; avoids the node indicator runner the full price loader needs."""
    def __init__(self):self.data={}
    def blob(self,name):
        store=self.data
        class _B:
            def download_as_bytes(self):return store[name]
        return _B()


def _bind(historical, **extra):
    bucket=_DataBucket()
    price={"capture_id":"capture","capture_manifest_path":"capture/raw/daily_price_full_vintage/manifest.json"}
    prices={1:[{"date":"2026-09-28","close":50.},{"date":"2026-09-29","close":52.}]}
    attach_long(bucket,price)
    snapshot={"3004":[{"date":"2026-09-27","dealer_net":7.,"broker_net_shares":99.,"broker_concentration":.9},
                      {"date":"2026-09-28","dealer_net":1.,"broker_net_shares":99.,"broker_estimated_amount":1e9,"broker_count":40}]}
    result=bind_long_sources(bucket,price_capture=price,stock_rows=[{"id":1,"symbol":"3004"}],prices_map=prices,
        prior_ts={1:{"2026-09-28":{"eps":3.}}},prior_chips=snapshot,run_date="2026-09-29",
        **({"historical_broker":True} if historical else {}),**extra)
    return prices,result


def test_r33_historical_broker_binds_every_date_and_clears_snapshot():
    prices,(dated,chips,proof)=_bind(True)
    rows={r["date"]:r for r in chips["3004"]}
    close={r["date"]:r["close"] for r in prices[1]}
    # Snapshot-only date keeps unrelated chips but loses every broker value.
    assert rows["2026-09-27"]=={"date":"2026-09-27","dealer_net":7.}
    assert rows["2026-09-28"]["dealer_net"]==1. and rows["2026-09-28"]["broker_net_shares"]==4.
    assert rows["2026-09-28"]["broker_estimated_amount"]==4.*close["2026-09-28"]*1000.
    assert rows["2026-09-28"]["broker_concentration"]==.2 and rows["2026-09-28"]["broker_count"]==3
    assert rows["2026-09-29"]["broker_net_shares"]==5. and rows["2026-09-29"]["broker_count"]==4
    binding=proof["historical_broker_binding"]
    assert binding["rows_bound"]==2 and binding["date_min"]=="2026-09-28"
    assert "known after the d-day close" in binding["policy"] and "not certified" in binding["policy"]
    from services.pit_certification import contract_content_sha256,load_contract
    assert (binding["availability_level"],binding["lag_sessions"])==("R",0)
    assert binding["contract_sha256"]==contract_content_sha256(load_contract())
    assert "retail_pct" not in dated[1]["2026-09-28"]


def test_broker_policy_refuses_a_contract_lag_the_feature_layer_would_not_apply(monkeypatch):
    import copy
    from services import pit_certification
    from services.training_long_sources import historical_broker_policy
    contract=copy.deepcopy(pit_certification.load_contract());contract["datasets"]["broker"]["lag_sessions"]=1
    assert "same-day" in historical_broker_policy()["policy"]
    monkeypatch.setattr(pit_certification,"load_contract",lambda *a,**k:contract)
    with pytest.raises(ValueError,match="training_broker_contract_lag_unowned"):
        historical_broker_policy()
    contract["feature_lags"].update({f:1 for f in ("broker_net_shares","broker_estimated_amount","broker_concentration","broker_count")})
    policy=historical_broker_policy()
    assert policy["lag_sessions"]==1 and "same-day" not in policy["policy"]
    assert "serving must build broker features with pit-availability-contract-v1" in policy["policy"]


def test_non_r33_long_binding_is_unchanged():
    _,default=_bind(False)
    _,explicit=_bind(False,historical_broker=False)
    assert json.dumps(default,sort_keys=True,default=str)==json.dumps(explicit,sort_keys=True,default=str)
    _,chips,proof=default
    rows={r["date"]:r for r in chips["3004"]}
    assert rows["2026-09-28"]["broker_net_shares"]==99. and rows["2026-09-27"]["broker_concentration"]==.9
    assert rows["2026-09-29"]["broker_net_shares"]==5. and "historical_broker_binding" not in proof


def test_historical_broker_refuses_inference_composition():
    with pytest.raises(ValueError,match="training_historical_broker_requires_capture"):
        _bind(True,inference_composition={"long":{}})



def test_pandas_broker_capture_matches_full_lazy_aggregation(tmp_path,monkeypatch):
    import numpy as np,pandas as pd
    import services.training_long_sources as module
    rng=np.random.default_rng(11);rows=[]
    for day in pd.date_range("2026-08-25","2026-10-06"):
        for symbol in ("2330","00878","6488"):
            for broker in ("1020","9A00","1030"):
                rows.append([day+pd.Timedelta(hours=int(rng.integers(0,20))),symbol,broker,float(rng.integers(0,5)*1000),float(rng.integers(0,5)*1000)])
        rows.append([day,"3008","1020",5000.,0.]);rows.append([day,"3008","9A00",0.,5000.])  # |net| tie, opposite signs
        rows.append([day,"3008","1030",None,2000.])
    frame=pd.DataFrame(rows,columns=["date","symbol","broker","buy","sell"]).sample(frac=1.,random_state=5).reset_index(drop=True)
    frame.loc[4,"date"]=pd.NaT;frame.loc[9,"sell"]=float("nan");frame["stock_id"]=frame["symbol"]
    old=write_broker_capture(pl.from_pandas(frame).lazy(),run_dir=tmp_path/"old",start="2026-09-01",end="2026-09-29")
    seen=[];convert=pl.from_pandas
    monkeypatch.setattr(module.pl,"from_pandas",lambda f,*a,**k:(seen.append(f.shape),convert(f,*a,**k))[1])
    new=write_broker_capture(frame,run_dir=tmp_path/"new",start="2026-09-01",end="2026-09-29")
    assert new["sha256"]==old["sha256"] and new["rows"]==old["rows"]
    assert (tmp_path/"new/raw/training_long_full_vintage/broker.parquet").read_bytes()==(tmp_path/"old/raw/training_long_full_vintage/broker.parquet").read_bytes()
    assert seen and max(r for r,_ in seen)<len(frame)/4 and {c for _,c in seen}=={5}
    with pytest.raises(ValueError,match="training_long_source_empty:broker"):
        write_broker_capture(frame,run_dir=tmp_path/"empty",start="2027-01-01",end="2027-01-10")
