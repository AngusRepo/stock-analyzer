"""Verified full-window market inputs shared by prep and daily payloads."""
from __future__ import annotations
import hashlib,io,json,re
from datetime import date
import polars as pl

def parse_breadth(body,day):
    if body.get("stat")!="OK" or body.get("date")!=day.replace("-",""):raise ValueError("training_breadth_date_or_status_invalid")
    tables=[t for t in body.get("tables",[]) if t.get("fields")==["類型","整體市場","股票"]]
    if len(tables)!=1:raise ValueError("training_breadth_table_missing")
    def number(prefix):
        rows=[r for r in tables[0]["data"] if str(r[0]).startswith(prefix)]
        if len(rows)!=1:raise ValueError("training_breadth_count_missing")
        match=re.fullmatch(r"([0-9,]+)(?:\([0-9,]+\))?",str(rows[0][2]).strip())
        if not match:raise ValueError("training_breadth_count_invalid")
        return int(match[1].replace(",",""))
    return {"date":day,"advance":number("上漲"),"decline":number("下跌")}

def read_market_history(bucket, *,price_capture,us_component):
    from services.training_session_calendar import verify_training_calendar,official_month_sessions
    calendar=verify_training_calendar(bucket,price_capture=price_capture)
    root=price_capture["capture_manifest_path"].rsplit("/",1)[0]
    calendar_receipt=json.loads(bucket.blob(root+"/training_calendar.json").download_as_bytes())
    closes={}
    for item in calendar_receipt["sources"]:
        if item["market"]!="TWSE":continue
        raw=bucket.blob(root+"/official_calendar/TWSE-"+item["month"]+".json").download_as_bytes()
        if hashlib.sha256(raw).hexdigest()!=item["sha256"]:raise ValueError("training_global_index_checksum_mismatch")
        body=json.loads(raw);official_month_sessions(body,"TWSE",item["month"])
        for row in body["data"]:
            year,month,day=map(int,row[0].split("/"));year=year+1911 if year<1911 else year
            d=date(year,month,day).isoformat()
            if calendar["start"]<=d<=calendar["end"]:closes[d]=float(str(row[4]).replace(",",""))
    breadth_path=root+"/training_breadth.json";raw=bucket.blob(breadth_path).download_as_bytes();breadth=json.loads(raw)
    if breadth.get("capture_id")!=price_capture["capture_id"] or breadth.get("end")!=calendar["end"]:
        raise ValueError("training_global_breadth_identity_mismatch")
    counts={}
    for item in breadth.get("sources",[]):
        day=item["date"];data=bucket.blob(root+"/official_breadth/"+day+".json").download_as_bytes()
        if hashlib.sha256(data).hexdigest()!=item["sha256"]:raise ValueError("training_global_breadth_checksum_mismatch")
        if day in counts:raise ValueError("training_global_breadth_duplicate")
        counts[day]=parse_breadth(json.loads(data),day)
    if set(counts)!=set(closes):raise ValueError("training_global_breadth_window_gap")
    uri=str(us_component.get("gcs_uri") or "")
    if not uri.startswith("gs://"+bucket.name+"/"):raise ValueError("training_global_us_source_bucket_mismatch")
    us_raw=bucket.blob(uri.split("/",3)[3]).download_as_bytes()
    if "sha256:"+hashlib.sha256(us_raw).hexdigest()!=us_component.get("content_checksum"):
        raise ValueError("training_global_us_checksum_mismatch")
    us_frame=pl.read_parquet(io.BytesIO(us_raw))
    if us_frame.height!=us_component.get("row_count") or us_frame["date"].is_duplicated().any():raise ValueError("training_global_us_shape_mismatch")
    days=sorted(closes);history={}
    from services.training_us_capture import read_us_quote_history
    us,us_proof=read_us_quote_history(bucket,price_capture=price_capture,days=days)
    for i,day in enumerate(days):
        count=counts[day];total=count["advance"]+count["decline"]
        if total<=0:raise ValueError("training_global_breadth_total_invalid")
        values={"market_return_1d":closes[day]/closes[days[i-1]]-1 if i else 0.,
            "market_return_5d":closes[day]/closes[days[i-5]]-1 if i>=5 else 0.,
            "market_bias_20d":closes[day]/(sum(closes[d] for d in days[i-19:i+1])/20)-1 if i>=19 else 0.,
            "advance_ratio":round(count["advance"]/total,4),
            "market_proxy_symbol":"TAIEX","market_proxy_source":"sealed_official_twse_monthly"}
        values.update(us[day])
        history[day]=values
    proof={"schema_version":"training-global-capture-binding-v1","capture_id":price_capture["capture_id"],"calendar":calendar,
        "breadth_manifest_path":breadth_path,"breadth_manifest_sha256":hashlib.sha256(raw).hexdigest(),
        "us_component":us_component,"us_quote_capture":us_proof,"us_date_semantic":"US quote date strictly before TW date; legacy D1 mixed-date values excluded","dates":len(days),
        "history_sha256":hashlib.sha256(json.dumps(history,sort_keys=True,allow_nan=False).encode()).hexdigest(),
        "historical_us_source_timestamps_certified":False}
    return history,proof
