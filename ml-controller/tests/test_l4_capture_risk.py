import hashlib,json
import pytest
from services.l4_risk_history import load_canonical_risk_payloads
from test_training_price_capture import fixture,load


def source_fixture():
    bucket=fixture();_,_,proof=load(bucket)
    receipt={"status":"ready","business_date":"2026-09-29","output_gcs_prefix":"features","price_capture":proof}
    receipt["receipt_checksum"]=hashlib.sha256(json.dumps(receipt,sort_keys=True).encode()).hexdigest()
    bucket.data["features/prep/immutable_receipt.json"]=json.dumps(receipt).encode()
    source={"status":"ready","signal_date":"2026-09-29","source_gcs_prefix":"features",
        "source_receipt_checksum":receipt["receipt_checksum"],"sequence_gcs_prefix":"seq"}
    return bucket,source


def run(bucket,source):
    return load_canonical_risk_payloads(payloads=[{"symbol":"3004","stock_id":1,"prices":[{"date":"2026-09-29","adj_close":999.}]}],
        held_payloads=[{"symbol":"absent","stock_id":2,"prices":[{"date":"2026-09-29","adj_close":999.}]}],
        signal_date="2026-09-29",lookback=20,capture_source=source,bucket=bucket)


def test_risk_reads_exact_feature_capture_and_preserves_missing_held_prices():
    rows=run(*source_fixture())
    assert [r["adj_close"] for r in rows[0]["prices"]]==[50.5,51.]
    assert [r["adj_close"] for r in rows[1]["prices"]]==[None,None]
    assert rows[0]["price_capture"]==rows[1]["price_capture"]
    assert all(r["legacy_price_fallback"] is False for r in rows)


@pytest.mark.parametrize("fault,reason",[("missing_source","source_required"),("stale","source_required"),
    ("receipt","receipt_mismatch"),("prices","price_checksum_mismatch"),("manifest","manifest_mismatch"),
    ("sequence","sequence_capture_mismatch")])
def test_bad_risk_capture_fails_without_d1_fallback(fault,reason):
    bucket,source=source_fixture()
    if fault=="missing_source":source=None
    elif fault=="stale":source["signal_date"]="2026-09-28"
    elif fault=="receipt":source["source_receipt_checksum"]="wrong"
    elif fault=="prices":bucket.data["capture/raw/daily_price_full_vintage/adj_close.parquet"]+=b"changed"
    elif fault=="manifest":bucket.data["capture/raw/daily_price_full_vintage/manifest.json"]+=b" "
    else:
        path="features/prep/immutable_receipt.json";receipt=json.loads(bucket.data[path]);receipt.pop("receipt_checksum")
        receipt["price_capture"]["sequence_manifest_checksum"]="wrong"
        receipt["receipt_checksum"]=hashlib.sha256(json.dumps(receipt,sort_keys=True).encode()).hexdigest()
        source["source_receipt_checksum"]=receipt["receipt_checksum"];bucket.data[path]=json.dumps(receipt).encode()
    with pytest.raises(ValueError,match=reason):run(bucket,source)
