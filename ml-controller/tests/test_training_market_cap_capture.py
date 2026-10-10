import hashlib,io,json
import polars as pl
import pytest
from test_training_price_capture import fixture,load
from services.training_price_capture import load_training_market_cap_capture

def setup(values=(100.,None)):
    bucket=fixture();root="capture/raw/daily_price_full_vintage"
    buf=io.BytesIO();pl.DataFrame({"date":["2026-09-28","2026-09-29"],"3004":values}).write_parquet(buf)
    raw=buf.getvalue();bucket.data[root+"/market_value.parquet"]=raw
    manifest=json.loads(bucket.data[root+"/manifest.json"]);manifest["checksums"]["market_value"]=hashlib.sha256(raw).hexdigest()
    bucket.data[root+"/manifest.json"]=json.dumps(manifest).encode()
    prices,_,proof=load(bucket)
    return bucket,prices,proof

def run(bucket,prices,proof):
    return load_training_market_cap_capture(bucket,price_capture=proof,stock_rows=[{"id":1,"symbol":"3004"}],prices_map=prices,
        prior_ts={1:{"2026-09-27":{"market_cap_proxy":999.,"eps":3.},"2026-09-29":{"market_cap_proxy":999.,"eps":4.}}})

def test_dated_cap_preserves_null_and_drops_stale_scalar():
    rows,proof=run(*setup())
    assert rows[1]["2026-09-27"]=={"eps":3.}
    assert rows[1]["2026-09-28"]=={"market_cap_proxy":100.}
    assert rows[1]["2026-09-29"]=={"market_cap_proxy":None,"eps":4.}
    assert proof["rows"]==2 and proof["source_null_count"]==1

@pytest.mark.parametrize("values",[(float('inf'),1.),(-1.,1.),(None,None)])
def test_invalid_cap_rejected(values):
    with pytest.raises(ValueError,match="root_market_cap_"):run(*setup(values))

@pytest.mark.parametrize("fault",["missing","tamper","manifest"])
def test_missing_or_changed_source_rejected(fault):
    bucket,prices,proof=setup();root="capture/raw/daily_price_full_vintage"
    if fault=="tamper":bucket.data[root+"/market_value.parquet"]+=b"changed"
    elif fault=="manifest":bucket.data[root+"/manifest.json"]+=b" "
    else:
        manifest=json.loads(bucket.data[root+"/manifest.json"]);manifest["checksums"].pop("market_value")
        raw=json.dumps(manifest).encode();bucket.data[root+"/manifest.json"]=raw
        proof["capture_manifest_sha256"]=hashlib.sha256(raw).hexdigest()
    with pytest.raises(ValueError,match="root_market_cap_"):run(bucket,prices,proof)


def test_vendor_absent_cap_column_is_explicit_and_not_backfilled():
    bucket,prices,proof=setup();prices[2]=prices[1]
    rows,evidence=load_training_market_cap_capture(bucket,price_capture=proof,
        stock_rows=[{"id":1,"symbol":"3004"},{"id":2,"symbol":"0050"}],
        prices_map=prices,prior_ts={2:{"2026-09-29":{"market_cap_proxy":999.}}})
    assert evidence["vendor_absent_symbol_columns"]==["0050"]
    assert rows[2]["2026-09-29"]["market_cap_proxy"] is None


def test_all_etf_slate_keeps_vendor_absent_cap_without_false_source_failure():
    bucket,prices,proof=setup()
    rows,evidence=load_training_market_cap_capture(bucket,price_capture=proof,
        stock_rows=[{"id":1,"symbol":"0050"}],prices_map=prices,prior_ts={})
    assert evidence["vendor_absent_symbol_columns"]==["0050"]
    assert all(row["market_cap_proxy"] is None for row in rows[1].values())
