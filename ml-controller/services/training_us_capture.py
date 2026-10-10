"""Original quote owners, explicit US observation dates, conservative TW availability."""
from __future__ import annotations
import bisect,hashlib,json,math
from datetime import datetime,timezone,date,timedelta
from pathlib import Path

SYMBOLS={"sox":"^SOX","gspc":"^GSPC","vix":"^VIX","dxy":"DX-Y.NYB"}

def quote_series(body,symbol):
    if body.get("meta",{}).get("symbol")!=symbol:raise ValueError("training_us_quote_owner_mismatch")
    times=body.get("timestamp",[]);values=body.get("indicators",{}).get("quote",[{}])[0].get("close",[])
    if not times or len(times)!=len(values):raise ValueError("training_us_quote_shape_invalid")
    rows={}
    for stamp,value in zip(times,values,strict=True):
        day=datetime.fromtimestamp(stamp,tz=timezone.utc).date().isoformat()
        if value is None:continue
        if not math.isfinite(value) or value<=0 or day in rows:raise ValueError("training_us_quote_value_invalid")
        rows[day]=float(value)
    if len(rows)<2:raise ValueError("training_us_quote_history_empty")
    return rows

def write_us_quote_capture(*,run_dir,start,end,fetch=None):
    from urllib.parse import quote,urlencode
    from urllib.request import Request,urlopen
    def network(symbol):
        params=urlencode({"period1":int(datetime.combine(date.fromisoformat(start)-timedelta(days=30),datetime.min.time(),timezone.utc).timestamp()),
            "period2":int(datetime.combine(date.fromisoformat(end)+timedelta(days=1),datetime.min.time(),timezone.utc).timestamp()),"interval":"1d"})
        req=Request("https://query1.finance.yahoo.com/v8/finance/chart/"+quote(symbol,safe="")+"?"+params,headers={"User-Agent":"Mozilla/5.0"})
        with urlopen(req,timeout=60) as response:payload=json.load(response)
        if payload["chart"].get("error"):raise ValueError("training_us_quote_provider_error")
        return payload["chart"]["result"][0]
    root=Path(run_dir)/"raw/daily_price_full_vintage/us_quotes";root.mkdir(parents=True,exist_ok=True)
    sources={}
    for field,symbol in SYMBOLS.items():
        body=(fetch or network)(symbol);rows=quote_series(body,symbol)
        raw=json.dumps(body,sort_keys=True,allow_nan=False).encode();(root/(field+".json")).write_bytes(raw)
        sources[field]={"symbol":symbol,"sha256":hashlib.sha256(raw).hexdigest(),"rows":len(rows)}
    receipt={"schema_version":"training-us-quotes-v1","capture_id":Path(run_dir).name,"start":start,"end":end,"sources":sources,
        "availability":"US observation date strictly before TW business date; maximum seven calendar days stale",
        "hy_policy":"optional unavailable branch; no historical release vintage is invented"}
    (root.parent/"training_us_quotes.json").write_text(json.dumps(receipt,sort_keys=True),encoding="utf8")
    return receipt

def read_us_quote_history(bucket,*,price_capture,days):
    root=price_capture["capture_manifest_path"].rsplit("/",1)[0]
    raw=bucket.blob(root+"/training_us_quotes.json").download_as_bytes();meta=json.loads(raw)
    if meta.get("schema_version")!="training-us-quotes-v1" or meta.get("capture_id")!=price_capture["capture_id"] or meta.get("end")!=days[-1]:raise ValueError("training_us_capture_identity_mismatch")
    series={}
    for field,symbol in SYMBOLS.items():
        source=meta.get("sources",{}).get(field,{})
        rawquote=bucket.blob(root+"/us_quotes/"+field+".json").download_as_bytes()
        if hashlib.sha256(rawquote).hexdigest()!=source.get("sha256") or source.get("symbol")!=symbol:raise ValueError("training_us_quote_checksum_mismatch")
        rows=quote_series(json.loads(rawquote),symbol)
        if len(rows)!=source.get("rows"):raise ValueError("training_us_quote_rows_mismatch")
        series[field]=(sorted(rows),rows)
    output={};owners={}
    for day in days:
        values={};known={}
        for field,(dates,rows) in series.items():
            i=bisect.bisect_left(dates,day)-1
            if i<1 or (date.fromisoformat(day)-date.fromisoformat(dates[i])).days>7:raise ValueError("training_us_quote_date_gap:"+field+":"+day)
            known[field]=dates[i]
            values["us_"+field+ ("" if field=="vix" else "_return")]=rows[dates[i]] if field=="vix" else rows[dates[i]]/rows[dates[i-1]]-1
        bull=sum([values["us_sox_return"]>.01,values["us_gspc_return"]>.005,values["us_vix"]<20])
        bear=sum([values["us_sox_return"]<-.02,values["us_gspc_return"]<-.01,values["us_vix"]>30])
        values.update(us_sentiment_score=1. if bull>=2 else (-1. if bear>=2 else 0.),us_hy_spread=None,us_hy_spread_chg=None)
        output[day]=values;owners[day]=known
    return output,{"manifest_sha256":hashlib.sha256(raw).hexdigest(),"capture_id":meta["capture_id"],"sources":meta["sources"],
        "owner_dates":owners,"hy_policy":meta["hy_policy"],"retrospective_vendor_values_not_original_vintage":True}
