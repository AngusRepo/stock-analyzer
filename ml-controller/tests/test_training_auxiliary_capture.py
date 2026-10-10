import hashlib,io,json
from copy import deepcopy
import polars as pl
import pytest
from services.training_auxiliary_capture import FIELDS,load_training_auxiliary_capture
from test_training_market_cap_capture import setup

def attach(bucket,price):
    root=price["capture_manifest_path"].rsplit("/daily_price_full_vintage/",1)[0]+"/training_auxiliary_full_vintage"
    manifest={"schema_version":"finlab-training-auxiliary-single-capture-v1","capture_id":price["capture_id"],"end_date":"2026-09-29","fields":{}}
    for field in FIELDS:
        f=pl.DataFrame({"date":["2026-09-28","2026-09-29"],"3004":[10.,None]})
        b=io.BytesIO();f.write_parquet(b);raw=b.getvalue();bucket.data[root+"/"+field+".parquet"]=raw
        manifest["fields"][field]={"sha256":hashlib.sha256(raw).hexdigest(),"rows":2,"columns":["3004"],"availability":"vendor_date_index"}
    raw=json.dumps(manifest).encode();bucket.data[root+"/manifest.json"]=raw
    return {"schema_version":"training-auxiliary-capture-binding-v1","capture_id":price["capture_id"],"capture_manifest_path":root+"/manifest.json","capture_manifest_sha256":hashlib.sha256(raw).hexdigest(),"fields":manifest["fields"]}

def run(bucket,prices,price):
    return load_training_auxiliary_capture(bucket,price_capture=price,stock_rows=[{"id":1,"symbol":"3004"}],prices_map=prices,
        prior_ts={1:{"2026-09-29":{"eps":999.,"short_ratio":999.,"market_cap_proxy":123.}}},
        prior_chips={"3004":[{"date":"2026-09-28","dealer_net":4.,"margin_balance":999.}]},run_date="2026-09-29")

def test_raw_null_zero_history_and_ratio():
    bucket,prices,price=setup();attach(bucket,price)
    rows,chips,proof=run(bucket,prices,price)
    assert rows[1]["2026-09-28"]["short_ratio"]==1.
    assert rows[1]["2026-09-29"]["eps"] is None and rows[1]["2026-09-29"]["short_ratio"] is None
    assert rows[1]["2026-09-29"]["market_cap_proxy"]==123.
    assert chips["3004"][0]["margin_balance"]==10. and chips["3004"][0]["dealer_net"]==4.
    assert set(proof["fields"])==set(FIELDS)

@pytest.mark.parametrize("fault",["missing","tamper","gap","identity"])
def test_rejects_auxiliary_source_faults(fault):
    bucket,prices,price=setup();proof=attach(bucket,price);path=proof["capture_manifest_path"];manifest=json.loads(bucket.data[path]);root=path.rsplit("/",1)[0]
    if fault=="missing":manifest["fields"].pop("eps")
    elif fault=="identity":manifest["capture_id"]="another"
    elif fault=="tamper":bucket.data[root+"/eps.parquet"]+=b"tamper"
    elif fault=="gap":
        f=pl.DataFrame({"date":["2026-09-28"],"3004":[10.]});b=io.BytesIO();f.write_parquet(b);raw=b.getvalue()
        bucket.data[root+"/margin_balance.parquet"]=raw;manifest["fields"]["margin_balance"].update(sha256=hashlib.sha256(raw).hexdigest(),rows=1)
    bucket.data[path]=json.dumps(manifest).encode()
    with pytest.raises(ValueError,match="root_auxiliary_"):run(bucket,prices,price)
