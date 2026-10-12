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


def captured_allocator_fixture():
    from copy import deepcopy
    from test_l4_risk_history import payload
    from services.paired_nav_collection import capture_allocator_return_history
    original=[payload('3004'),payload('absent')]
    rows=run(*source_fixture())
    for row,base in zip(rows,original):
        row['prices']=deepcopy(base['prices'])
        row['as_of_date']='2026-09-11'
    context=capture_allocator_return_history(payloads=original,signal_date='2026-09-11',
        held_payloads=[],canonical_risk_payloads=rows)
    return original,context


def test_capture_producer_provenance_survives_allocator_replay():
    from services.paired_nav_collection import replay_allocator_return_history
    original,context=captured_allocator_fixture()
    assert replay_allocator_return_history(context,payloads=original,signal_date='2026-09-11')==context['return_history']


@pytest.mark.parametrize('fault',['missing_proof','bad_hash','mixed_capture','mixed_owner','fallback','unknown_owner','wrong_date','price_tamper'])
def test_capture_replay_rejects_forged_provenance_and_changed_values(fault):
    from services.paired_nav_collection import replay_allocator_return_history,digest
    original,context=captured_allocator_fixture()
    row=context['canonical_risk_payloads'][0]
    if fault=='missing_proof':row.pop('price_capture')
    elif fault=='bad_hash':row['price_capture']['adj_close_sha256']='bad'
    elif fault=='mixed_capture':row['price_capture']={**row['price_capture'],'capture_id':'other'}
    elif fault=='mixed_owner':row.pop('price_capture');row['source']='market.canonical_market_daily.adj_close'
    elif fault=='fallback':row['legacy_price_fallback']=True
    elif fault=='unknown_owner':row['source']='unverified'
    elif fault=='wrong_date':row['as_of_date']='2026-09-10'
    else:row['prices'][10]['adj_close']+=1
    context['content_checksum']=digest({k:v for k,v in context.items() if k!='content_checksum'})
    with pytest.raises(ValueError,match='l4_risk_|paired_nav_allocator_history_replay_mismatch'):
        replay_allocator_return_history(context,payloads=original,signal_date='2026-09-11')
