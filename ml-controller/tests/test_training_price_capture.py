import hashlib
import io
import json
import polars as pl
import pytest
from services.training_price_capture import load_training_price_capture, PRICE_FIELDS


class Bucket:
    name="fixture"
    def __init__(self):self.data={}
    def blob(self,path):
        owner=self
        class Blob:
            def exists(self):return path in owner.data
            def download_as_bytes(self):return owner.data[path]
            def download_as_text(self):return owner.data[path].decode()
        return Blob()


def fixture():
    bucket=Bucket();root="capture/raw/daily_price_full_vintage";checksums={}
    values={"open":[100.,101.],"close":[101.,102.],"high":[102.,103.],"low":[99.,100.],
            "volume":[1000.,1100.],"value":[101000.,112200.],"adj_close":[50.5,51.],"adj_open":[50.,50.5]}
    for field in PRICE_FIELDS:
        frame=pl.DataFrame({"date":["2026-09-28","2026-09-29"],"3004":values[field]})
        buf=io.BytesIO();frame.write_parquet(buf);raw=buf.getvalue();bucket.data[f"{root}/{field}.parquet"]=raw
        checksums[field]=hashlib.sha256(raw).hexdigest()
    manifest={"schema_version":"finlab-adjusted-price-single-capture-v1","capture_id":"capture-1",
              "end_date":"2026-09-29","checksums":checksums}
    bucket.data[f"{root}/manifest.json"]=json.dumps(manifest).encode()
    seq={"status":"ready","output_gcs_prefix":"seq","lane_reports":[{"lane":"daily_price","source_uri":{
        "capture_id":"capture-1","close":f"gs://fixture/{root}/adj_close.parquet",
        "open":f"gs://fixture/{root}/adj_open.parquet","checksums":checksums}}]}
    seq["manifest_checksum"]=hashlib.sha256(json.dumps(seq,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    bucket.data["seq/prep/sequence_manifest.json"]=json.dumps(seq).encode()
    return bucket


def load(bucket,**extra):
    return load_training_price_capture(bucket,sequence_gcs_prefix="seq",stock_rows=[{"id":1,"symbol":"3004"}],
        prices_lookback=100,run_date="2026-09-29",prior_prices=extra.get("prior_prices",{}),
        prior_indicators=extra.get("prior_indicators",{}))


def test_actual_prices_replace_snapshot_values_and_missing_day():
    prices,indicators,proof=load(fixture(),prior_prices={1:[{"date":"2026-09-29","close":999.}]},
                               prior_indicators={1:[{"date":"2026-09-29","ma5":999.}]})
    assert [r["date"] for r in prices[1]]==["2026-09-28","2026-09-29"]
    assert [r["adj_close"] for r in prices[1]]==[50.5,51.]
    assert [r["close"] for r in prices[1]]==[101.,102.]
    assert indicators[1]==[] and proof["indicators_recomputed_symbols"]==["3004"]
    assert proof["rows"]==2 and len(proof["actual_price_values_sha256"])==64


def test_unchanged_raw_history_still_rejects_unsealed_stale_indicators():
    bucket=fixture();prices,_,_=load(bucket)
    expected={1:[{"date":"2026-09-29","ma5":99.}]}
    _,indicators,proof=load(bucket,prior_prices=prices,prior_indicators=expected)
    assert indicators=={1:[]} and proof["indicators_recomputed_symbols"]==["3004"]


def test_tamper_fails_before_price_binding():
    bucket=fixture();bucket.data["capture/raw/daily_price_full_vintage/adj_close.parquet"]+=b"corrupt"
    with pytest.raises(ValueError,match="checksum_mismatch"):load(bucket)


def test_missing_raw_source_is_not_silently_refilled_from_snapshot():
    bucket=fixture();path="capture/raw/daily_price_full_vintage/manifest.json"
    manifest=json.loads(bucket.data[path]);manifest["checksums"].pop("volume");bucket.data[path]=json.dumps(manifest).encode()
    with pytest.raises(ValueError,match="field_missing:volume"):load(bucket)


def test_loss_of_previously_eligible_symbol_fails():
    with pytest.raises(ValueError,match="lost_eligible_symbol"):
        load(fixture(),prior_prices={1:[{"date":"2026-01-01","close":10.}]*60})


def institutional_fixture():
    from services.training_price_capture import INSTITUTIONAL_FIELDS
    bucket=fixture();prices,_,proof=load(bucket);root="capture/raw/chip_diversity_full_vintage";checksums={}
    for field in INSTITUTIONAL_FIELDS:
        values=[0.,None] if field=="dealer_hedge_net" else [10.,20.]
        frame=pl.DataFrame({"date":["2026-09-28","2026-09-29"],"3004":values})
        buf=io.BytesIO();frame.write_parquet(buf);raw=buf.getvalue();bucket.data[f"{root}/{field}.parquet"]=raw
        checksums[field]=hashlib.sha256(raw).hexdigest()
    bucket.data[f"{root}/manifest.json"]=json.dumps({"schema_version":"finlab-institutional-single-capture-v1",
        "capture_id":"capture-1","end_date":"2026-09-29","checksums":checksums}).encode()
    return bucket,prices,proof


def load_chips(bucket,prices,proof):
    from services.training_price_capture import load_training_institutional_capture
    return load_training_institutional_capture(bucket,price_capture=proof,run_date="2026-09-29",
        stock_rows=[{"id":1,"symbol":"3004"}],prices_map=prices,
        prior_chips={"3004":[{"date":"2026-09-29","dealer_net":999.,"dealer_hedge_net":999.,"broker_net":30.}]})


def test_institutional_actual_values_preserve_zero_null_and_broker_ownership():
    rows,proof=load_chips(*institutional_fixture())
    assert rows["3004"][0]["dealer_hedge_net"]==0. and rows["3004"][0]["dealer_net"]==10.
    assert rows["3004"][1]["dealer_hedge_net"] is None and rows["3004"][1]["dealer_net"] is None
    assert rows["3004"][1]["broker_net"]==30. and rows["3004"][1]["foreign_net"]==20.
    assert proof["source_null_counts"]["dealer_hedge_net"]==1


@pytest.mark.parametrize("fault,reason",[("tamper","checksum_mismatch"),("identity","identity_mismatch"),("field","field_missing")])
def test_institutional_bad_capture_is_rejected(fault,reason):
    bucket,prices,proof=institutional_fixture();root="capture/raw/chip_diversity_full_vintage"
    manifest=json.loads(bucket.data[f"{root}/manifest.json"])
    if fault=="tamper":bucket.data[f"{root}/foreign_net.parquet"]+=b"corrupt"
    elif fault=="identity":manifest["capture_id"]="other"
    else:manifest["checksums"].pop("foreign_net")
    bucket.data[f"{root}/manifest.json"]=json.dumps(manifest).encode()
    with pytest.raises(ValueError,match=reason):load_chips(bucket,prices,proof)


def test_missing_one_requested_price_symbol_does_not_silently_drop_pool_member():
    with pytest.raises(ValueError,match="root_price_capture_symbol_columns_missing:open:9999"):
        load_training_price_capture(fixture(),sequence_gcs_prefix="seq",
            stock_rows=[{"id":1,"symbol":"3004"},{"id":2,"symbol":"9999"}],
            prices_lookback=100,run_date="2026-09-29",prior_prices={},prior_indicators={})


def test_missing_one_institutional_symbol_is_not_vendor_null():
    from services.training_price_capture import load_training_institutional_capture
    bucket,prices,proof=institutional_fixture()
    prices[2]=prices[1]
    with pytest.raises(ValueError,match="root_institutional_symbol_columns_missing:foreign_net:9999"):
        load_training_institutional_capture(bucket,price_capture=proof,run_date="2026-09-29",
            stock_rows=[{"id":1,"symbol":"3004"},{"id":2,"symbol":"9999"}],
            prices_map=prices,prior_chips={})

def test_leading_zero_security_cannot_be_reassigned_to_retired_numeric_alias():
    bucket=fixture();root="capture/raw/daily_price_full_vintage"
    for field in PRICE_FIELDS:
        frame=pl.read_parquet(io.BytesIO(bucket.data[f"{root}/{field}.parquet"])).rename({"3004":"009801"})
        buf=io.BytesIO();frame.write_parquet(buf);raw=buf.getvalue()
        bucket.data[f"{root}/{field}.parquet"]=raw
        manifest=json.loads(bucket.data[f"{root}/manifest.json"])
        manifest["checksums"][field]=hashlib.sha256(raw).hexdigest()
        bucket.data[f"{root}/manifest.json"]=json.dumps(manifest).encode()
    seq=json.loads(bucket.data["seq/prep/sequence_manifest.json"]);seq.pop("manifest_checksum")
    seq["lane_reports"][0]["source_uri"]["checksums"]=manifest["checksums"]
    seq["manifest_checksum"]=hashlib.sha256(json.dumps(seq,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    bucket.data["seq/prep/sequence_manifest.json"]=json.dumps(seq).encode()
    kwargs=dict(sequence_gcs_prefix="seq",prices_lookback=100,run_date="2026-09-29",prior_prices={},prior_indicators={})
    with pytest.raises(ValueError,match="symbol_columns_missing:open:9801"):
        load_training_price_capture(bucket,stock_rows=[{"id":293,"symbol":"9801"}],**kwargs)
    prices,_,_=load_training_price_capture(bucket,stock_rows=[{"id":20411,"symbol":"009801"}],**kwargs)
    assert prices[20411][0]["close"]==101. and 293 not in prices
