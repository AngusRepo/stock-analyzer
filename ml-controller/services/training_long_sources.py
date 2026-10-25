"""Full broker and holding captures with explicit historical availability limits."""
from __future__ import annotations
import hashlib,json,io
from datetime import date, timedelta
from pathlib import Path
import polars as pl

def _lazy(frame):
    if isinstance(frame,pl.LazyFrame):return frame
    if isinstance(frame,pl.DataFrame):return frame.lazy()
    return pl.from_pandas(frame).lazy()

BROKER_NATIVE_COLUMNS=("date","symbol","broker","buy","sell")
BROKER_AVAILABILITY="capture_observed; historic publication time not certified"

def _native_broker(f,start,end):
    return (f.select(pl.col("date").cast(pl.Date).cast(pl.String),pl.col("symbol").cast(pl.String),pl.col("broker").cast(pl.String),
        pl.col("buy").cast(pl.Float64),pl.col("sell").cast(pl.Float64)).filter(pl.col("date").is_between(pl.lit(start),pl.lit(end))))

def _broker_windows(start,end):
    lower, final = date.fromisoformat(start), date.fromisoformat(end)
    if lower > final:
        raise ValueError("training_broker_window_invalid")
    while lower <= final:
        upper = min(lower + timedelta(days=6), final)
        yield lower, upper
        lower = upper + timedelta(days=1)

def write_broker_capture(frame, *, run_dir, start, end):
    if not isinstance(frame,(pl.LazyFrame,pl.DataFrame)):
        import pandas as pd
        if set(BROKER_NATIVE_COLUMNS)<=set(frame.columns) and pd.api.types.is_datetime64_dtype(frame["date"]):
            return _write_pandas_broker_capture(frame,run_dir=run_dir,start=start,end=end)
    f=_lazy(frame)
    if not set(BROKER_NATIVE_COLUMNS)<=set(f.collect_schema().names()):raise ValueError("training_broker_native_schema_required")
    f=_native_broker(f,start,end)
    # Each date/symbol/broker key belongs to exactly one bounded window.
    # Limit group/sort state before collecting the111M-row native archive.
    pieces = [_aggregate_broker_window(f.filter(pl.col("date").is_between(pl.lit(lower.isoformat()), pl.lit(upper.isoformat()))))
              for lower, upper in _broker_windows(start, end)]
    out = pl.concat(pieces)
    return _write(out,run_dir=run_dir,name="broker",start=start,end=end,availability=BROKER_AVAILABILITY)

def _write_pandas_broker_capture(frame,*,run_dir,start,end):
    """Same windows and expressions as the lazy path, but only one window's five
    native columns are ever converted; the full vendor archive is not copied."""
    import numpy as np
    values=frame["date"].to_numpy();positions=[frame.columns.get_loc(c) for c in BROKER_NATIVE_COLUMNS];pieces=[]
    for lower, upper in _broker_windows(start, end):
        rows=np.flatnonzero((values>=np.datetime64(lower,"D"))&(values<np.datetime64(upper+timedelta(days=1),"D")))
        if len(rows):
            pieces.append(_aggregate_broker_window(_native_broker(pl.from_pandas(frame.take(rows).iloc[:,positions]).lazy(),start,end)))
    if not pieces:raise ValueError("training_long_source_empty:broker")
    return _write(pl.concat(pieces),run_dir=run_dir,name="broker",start=start,end=end,availability=BROKER_AVAILABILITY)

def _aggregate_broker_window(f):
    branches=f.group_by("date","symbol","broker").agg(pl.col("buy").sum(),pl.col("sell").sum()).with_columns((pl.col("buy")-pl.col("sell")).alias("net"))
    grouped=(branches.with_columns(pl.col("net").abs().alias("abs_net")).sort(["date","symbol","abs_net","broker"],descending=[False,False,True,False])
        .group_by("date","symbol",maintain_order=True).agg(pl.col("net").first().alias("broker_net_lots"),pl.col("abs_net").first().alias("dominant_abs_lots"),pl.col("buy").sum().alias("buy_lots"),pl.col("sell").sum().alias("sell_lots"),pl.len().alias("broker_count"))
        .with_columns((pl.col("dominant_abs_lots")/(pl.col("buy_lots").abs()+pl.col("sell_lots").abs()).clip(1,None)).alias("broker_concentration")))
    return grouped.collect(engine="streaming")


def write_holding_capture(frame, *, run_dir, start, end):
    f=_lazy(frame)
    required={"date","symbol","持股分級","占集保庫存數比例"}
    if not required<=set(f.collect_schema().names()):raise ValueError("training_holding_native_schema_required")
    out=(f.select(pl.col("date").cast(pl.Date).cast(pl.String),pl.col("symbol").cast(pl.String),pl.col("持股分級").cast(pl.String).cast(pl.Int64,strict=False).alias("level"),pl.col("占集保庫存數比例").cast(pl.Float64).alias("pct"))
        .filter(pl.col("date").is_between(pl.lit(start),pl.lit(end))&pl.col("level").is_between(1,4))
        .group_by("symbol","date").agg(pl.col("pct").sum().alias("retail_pct")).collect(engine="streaming"))
    return _write(out,run_dir=run_dir,name="holding",start=start,end=end,availability="capture_observed; observation date is not a publication timestamp")

def _write(frame, *,run_dir,name,start,end,availability):
    if frame.is_empty():raise ValueError("training_long_source_empty:"+name)
    if frame.unique(["symbol","date"]).height!=frame.height:raise ValueError("training_long_source_duplicate:"+name)
    root=Path(run_dir)/"raw/training_long_full_vintage";root.mkdir(parents=True,exist_ok=True)
    path=root/(name+".parquet");frame.sort("symbol","date").write_parquet(path)
    receipt={"schema_version":"training-long-source-capture-v1","capture_id":Path(run_dir).name,"source":name,"start":start,"end":end,"rows":frame.height,"columns":frame.columns,
        "sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"availability_policy":availability}
    (root/(name+".json")).write_text(json.dumps(receipt,sort_keys=True),encoding="utf8")
    return receipt

def inspect_long_capture(bucket, *,price_capture,name,run_date):
    root=price_capture["capture_manifest_path"].rsplit("/daily_price_full_vintage/",1)[0]+"/training_long_full_vintage"
    raw=bucket.blob(root+"/"+name+".json").download_as_bytes();meta=json.loads(raw)
    if meta.get("schema_version")!="training-long-source-capture-v1" or meta.get("capture_id")!=price_capture["capture_id"] or meta.get("end")!=run_date:
        raise ValueError("training_long_capture_identity_mismatch:"+name)
    data=bucket.blob(root+"/"+name+".parquet").download_as_bytes()
    if hashlib.sha256(data).hexdigest()!=meta.get("sha256"):raise ValueError("training_long_capture_checksum_mismatch:"+name)
    frame=pl.read_parquet(io.BytesIO(data))
    if frame.height!=meta["rows"] or set(frame.columns)!=set(meta["columns"]) or frame.unique(["symbol","date"]).height!=frame.height:
        raise ValueError("training_long_capture_shape_mismatch:"+name)
    return frame,{**meta,"manifest_path":root+"/"+name+".json","manifest_sha256":hashlib.sha256(raw).hexdigest()}


BROKER_FIELDS=("broker_net_shares","broker_estimated_amount","broker_concentration","broker_count")
# R33: d-day branch rows are known after d close, as serving reads same-day D1 rows.
# Dominant-branch ties: the capture picks the lowest broker code among equal |net|.
# canonical_broker_flow_daily (normalize_broker_transactions_daily) sorts the
# broker-ordered groupby output with a multi-key sort_values (stable np.lexsort), so
# it also keeps the lowest code. They can differ only where canonical's inputs
# differ: it strips broker codes and cleans symbols, the capture casts them raw.
HISTORICAL_BROKER_POLICY=("d-day broker branch rows are treated as known after the d-day close, matching serving's "
    "same-day canonical_broker_flow_daily rows; historic publication time is not certified")


def bind_long_sources(bucket, *,price_capture,stock_rows,prices_map,prior_ts,prior_chips,run_date,inference_composition=None,historical_broker=False):
    """Keep dated evidence; a fresh capture cannot make old reports known earlier.

    historical_broker (R33 only) replaces snapshot broker history with every capture
    row up to run_date under HISTORICAL_BROKER_POLICY.
    """
    if historical_broker and inference_composition is not None:
        raise ValueError("training_historical_broker_requires_capture")
    if inference_composition is None:
        broker,broker_proof=inspect_long_capture(bucket,price_capture=price_capture,name="broker",run_date=run_date)
        holding,holding_proof=inspect_long_capture(bucket,price_capture=price_capture,name="holding",run_date=run_date)
    else:
        from services.daily_inference_composition import read_frame
        broker=read_frame(bucket,inference_composition["long"]["broker"],run_date=run_date)
        holding=read_frame(bucket,inference_composition["long"]["holding"],run_date=run_date)
        proofs={name:{**inference_composition["long"][name],
            "manifest_path":inference_composition["manifest_path"],
            "manifest_sha256":inference_composition["manifest_sha256"]} for name in ("broker","holding")}
        broker_proof,holding_proof=proofs["broker"],proofs["holding"]
    ids={str(r["symbol"]):r["id"] for r in stock_rows}
    prices={s:{r["date"]:r for r in prices_map.get(sid,[])} for s,sid in ids.items()}
    chips={s:[dict(r) for r in rows] for s,rows in prior_chips.items()}
    index={s:{r["date"]:r for r in rows} for s,rows in chips.items()}
    dated={sid:{d:dict(r) for d,r in rows.items()} for sid,rows in prior_ts.items()}
    # Current-day branch observations are available at this capture. Earlier
    # snapshot observations retain their original conservative known dates.
    current=broker.filter((pl.col("date")==run_date)&pl.col("symbol").is_in(list(ids)))
    bound=current
    if historical_broker:
        # Never mix vintages: snapshot broker values are dropped before capture rows land.
        for rows in index.values():
            for row in rows.values():
                for field in BROKER_FIELDS:row.pop(field,None)
        bound=broker.filter((pl.col("date")<=run_date)&pl.col("symbol").is_in(list(ids)))
    for r in bound.iter_rows(named=True):
        sym,day=r["symbol"],r["date"];close=prices.get(sym,{}).get(day,{}).get("close")
        if close is None:continue
        target=index.setdefault(sym,{}).setdefault(day,{"date":day})
        target.update(broker_net_shares=r["broker_net_lots"],broker_estimated_amount=r["broker_net_lots"]*close*1000.,broker_concentration=r["broker_concentration"],broker_count=r["broker_count"])
    current_holding=(holding.filter((pl.col("date")<=run_date)&pl.col("symbol").is_in(list(ids)))
        .sort("symbol","date").group_by("symbol",maintain_order=True).tail(1))
    for r in current_holding.iter_rows(named=True):
        dated.setdefault(ids[r["symbol"]],{}).setdefault(run_date,{})["retail_pct"]=r["retail_pct"]
    proof={"schema_version":"inference-long-source-composition-binding-v1" if inference_composition else "training-long-source-binding-v1","capture_id":price_capture["capture_id"],
        "broker":broker_proof,"holding":holding_proof,"current_broker_rows":current.height,"current_holding_rows":current_holding.height,
        "historical_availability_policy":"retain previously observed snapshot dates; newly captured historical reports are not backdated",
        "historical_broker_rows_without_publication_attestation":broker.filter(pl.col("date")<run_date).height,
        "historical_holding_rows_without_publication_attestation":holding.filter(pl.col("date")<run_date).height}
    if historical_broker:
        proof["historical_broker_binding"]={"policy":HISTORICAL_BROKER_POLICY,"rows_bound":bound.height,
            "date_min":bound["date"].min() if bound.height else None,"snapshot_broker_fields_cleared":list(BROKER_FIELDS)}
    return dated,{s:sorted(rows.values(),key=lambda r:r["date"]) for s,rows in index.items()},proof
