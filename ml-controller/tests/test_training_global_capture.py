import io,json,hashlib
import polars as pl
import pytest
from services.training_global_capture import read_market_history,parse_breadth
from test_training_session_calendar import calendar_fixture

def attach_daily_calendar(bucket):
    template,_=calendar_fixture();root="capture/raw/daily_price_full_vintage"
    wide=pl.read_parquet(io.BytesIO(bucket.data[root+"/close.parquet"]))
    extra={str(i):[100.,101.] for i in range(3000,3100) if str(i) not in wide.columns}
    wide=wide.with_columns([pl.Series(k,v) for k,v in extra.items()]);b=io.BytesIO();wide.write_parquet(b)
    bucket.data[root+"/close.parquet"]=b.getvalue()
    for key,value in template.data.items():
        if "/official_calendar/" in key:bucket.data[key]=value
    manifest=json.loads(bucket.data[root+"/manifest.json"]);manifest["checksums"]["close"]=hashlib.sha256(b.getvalue()).hexdigest()
    calendar=json.loads(template.data[root+"/training_calendar.json"]);calendar["close_sha256"]=manifest["checksums"]["close"]
    raw=json.dumps(calendar).encode();bucket.data[root+"/training_calendar.json"]=raw;manifest["official_calendar_sha256"]=hashlib.sha256(raw).hexdigest()
    bucket.data[root+"/manifest.json"]=json.dumps(manifest).encode()

def attach_global(bucket,price):
    root=price["capture_manifest_path"].rsplit("/",1)[0];sources=[]
    for day in ("2026-09-28","2026-09-29"):
        body={"stat":"OK","date":day.replace("-",""),"tables":[{"fields":["類型","整體市場","股票"],"data":[["上漲","90","60"],["下跌","90","40"]]}]}
        raw=json.dumps(body).encode();bucket.data[root+"/official_breadth/"+day+".json"]=raw;sources.append({"date":day,"sha256":hashlib.sha256(raw).hexdigest()})
    bucket.data[root+"/training_breadth.json"]=json.dumps({"capture_id":price["capture_id"],"end":"2026-09-29","sources":sources}).encode()
    us=pl.DataFrame({"date":["2026-09-28","2026-09-29"],"sentiment":["bullish","bearish"],"vix_close":[18.,30.]});b=io.BytesIO();us.write_parquet(b);raw=b.getvalue();bucket.data["snapshot/us.parquet"]=raw
    meta={"gcs_uri":"gs://fixture/snapshot/us.parquet","content_checksum":"sha256:"+hashlib.sha256(raw).hexdigest(),"row_count":2}
    from datetime import datetime,timezone
    from services.training_us_capture import SYMBOLS
    sources={}
    stamps=[int(datetime(2026,9,d,14,tzinfo=timezone.utc).timestamp()) for d in [24,25,28,29]]
    for field,symbol in SYMBOLS.items():
        values=[18.,18.,31.,40.] if field=="vix" else [100.,102.,98.,900.]
        body={"meta":{"symbol":symbol},"timestamp":stamps,"indicators":{"quote":[{"close":values}]}}
        rawquote=json.dumps(body).encode();bucket.data[root+"/us_quotes/"+field+".json"]=rawquote
        sources[field]={"symbol":symbol,"sha256":hashlib.sha256(rawquote).hexdigest(),"rows":4}
    bucket.data[root+"/training_us_quotes.json"]=json.dumps({"schema_version":"training-us-quotes-v1","capture_id":price["capture_id"],"end":"2026-09-29","sources":sources,"hy_policy":"unavailable"}).encode()
    return read_market_history(bucket,price_capture=price,us_component=meta)[1]

def test_actual_global_history_and_tw_date_alignment():
    bucket,price=calendar_fixture();proof=attach_global(bucket,price)
    history,_=read_market_history(bucket,price_capture=price,us_component=proof["us_component"])
    assert history["2026-09-29"]["us_sentiment_score"]==-1.
    assert history["2026-09-28"]["advance_ratio"]==.6
    assert history["2026-09-29"]["market_return_1d"]==pytest.approx(.01)
    assert proof["dates"]==2

@pytest.mark.parametrize("fault",["breadth","us","gap"])
def test_global_sources_cannot_silently_default(fault):
    bucket,price=calendar_fixture();proof=attach_global(bucket,price);root=price["capture_manifest_path"].rsplit("/",1)[0]
    if fault=="us":bucket.data["snapshot/us.parquet"]+=b"tamper"
    elif fault=="breadth":bucket.data[root+"/official_breadth/2026-09-29.json"]+=b"tamper"
    else:
        r=json.loads(bucket.data[root+"/training_breadth.json"]);r["sources"].pop();bucket.data[root+"/training_breadth.json"]=json.dumps(r).encode()
    with pytest.raises(ValueError,match="training_global_"):read_market_history(bucket,price_capture=price,us_component=proof["us_component"])

def test_us_same_day_quote_cannot_leak_into_tw_features():
    bucket,price=calendar_fixture();proof=attach_global(bucket,price)
    history,_=read_market_history(bucket,price_capture=price,us_component=proof["us_component"])
    assert history["2026-09-29"]["us_sox_return"]==pytest.approx(98/102-1)
    assert history["2026-09-29"]["us_vix"]==31.
    assert proof["us_quote_capture"]["owner_dates"]["2026-09-29"]["sox"]=="2026-09-28"

def test_resealed_stale_us_history_is_rejected():
    bucket,price=calendar_fixture();proof=attach_global(bucket,price);root=price["capture_manifest_path"].rsplit("/",1)[0]
    path=root+"/us_quotes/sox.json";body=json.loads(bucket.data[path]);body["timestamp"]=[stamp-30*86400 for stamp in body["timestamp"]]
    raw=json.dumps(body).encode();bucket.data[path]=raw
    meta=json.loads(bucket.data[root+"/training_us_quotes.json"]);meta["sources"]["sox"]["sha256"]=hashlib.sha256(raw).hexdigest();bucket.data[root+"/training_us_quotes.json"]=json.dumps(meta).encode()
    with pytest.raises(ValueError,match="training_us_quote_date_gap"):
        read_market_history(bucket,price_capture=price,us_component=proof["us_component"])
