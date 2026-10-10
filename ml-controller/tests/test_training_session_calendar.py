import hashlib,io,json
import polars as pl
import pytest
from services.training_session_calendar import verify_training_calendar,require_session_equality
from test_training_price_capture import Bucket


def calendar_fixture():
    bucket=Bucket();root="capture/raw/daily_price_full_vintage"
    buffer=io.BytesIO();pl.DataFrame({"date":["2026-09-28","2026-09-29"],
        **{str(i):[100.,101.] for i in range(3000,3100)}}).write_parquet(buffer)
    raw=buffer.getvalue();bucket.data[root+"/close.parquet"]=raw
    sources=[]
    for market in ("TWSE","TPEX"):
        rows=[["115/09/28" if market=="TWSE" else "2026/09/28",1,1,1,100],
              ["115/09/29" if market=="TWSE" else "2026/09/29",1,1,1,101]]
        body={"date":"20260901","stat":"OK","data":rows} if market=="TWSE" else {
            "date":"20260901","tables":[{"fields":["日期"],"totalCount":2,"data":rows}]}
        value=json.dumps(body).encode();bucket.data[root+f"/official_calendar/{market}-2026-09.json"]=value
        sources.append({"market":market,"month":"2026-09","sha256":hashlib.sha256(value).hexdigest()})
    receipt={"schema_version":"official-training-calendar-v1","capture_id":"capture-1",
        "start":"2026-09-28","end":"2026-09-29","close_sha256":hashlib.sha256(raw).hexdigest(),"sources":sources}
    value=json.dumps(receipt).encode();bucket.data[root+"/training_calendar.json"]=value
    manifest={"capture_id":"capture-1","end_date":"2026-09-29","checksums":{"close":receipt["close_sha256"]},
        "official_calendar_sha256":hashlib.sha256(value).hexdigest()}
    value=json.dumps(manifest).encode();bucket.data[root+"/manifest.json"]=value
    return bucket,{"capture_id":"capture-1","capture_manifest_path":root+"/manifest.json",
        "capture_manifest_sha256":hashlib.sha256(value).hexdigest()}


def test_real_official_receipt_and_price_values_are_reverified():
    bucket,proof=calendar_fixture()
    result=verify_training_calendar(bucket,price_capture=proof)
    assert result["sessions"]==2 and result["start"]=="2026-09-28"


@pytest.mark.parametrize("fault",["missing_day","extra_day","otc_missing","empty"])
def test_entire_market_day_loss_is_not_legitimate_issuer_missingness(fault):
    actual=["2026-09-28","2026-09-29"]
    official={m:list(actual) for m in ("TWSE","TPEX")}
    if fault=="missing_day":actual.pop()
    elif fault=="extra_day":actual.append("2026-09-30")
    elif fault=="otc_missing":official["TPEX"].pop()
    else:official["TWSE"]=[]
    with pytest.raises(ValueError,match="training_calendar_session_gap"):
        require_session_equality(actual,official,start="2026-09-28",end="2026-09-30")


@pytest.mark.parametrize("fault",["price","calendar","official","capture"])
def test_checksum_or_source_changes_rejected(fault):
    bucket,proof=calendar_fixture();root="capture/raw/daily_price_full_vintage"
    path={"price":"close.parquet","calendar":"training_calendar.json",
          "official":"official_calendar/TWSE-2026-09.json","capture":"manifest.json"}[fault]
    bucket.data[root+"/"+path]+=b" "
    with pytest.raises(ValueError,match="training_calendar_"):verify_training_calendar(bucket,price_capture=proof)
