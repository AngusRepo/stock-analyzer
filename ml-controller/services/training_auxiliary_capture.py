"""Use sealed full vendor auxiliary history, not truncated hot D1 history."""
from __future__ import annotations
import hashlib,io,json
import polars as pl
FIELDS=("margin_balance","short_balance","pe","pb","dividend_yield","revenue","revenue_yoy","revenue_mom","eps","roe","revenue_growth_yoy")
DAILY_FIELDS=frozenset({"margin_balance","short_balance","pe","pb","dividend_yield"})

def load_training_auxiliary_capture(bucket, *, price_capture, stock_rows, prices_map, prior_ts, prior_chips, run_date):
    root=price_capture["capture_manifest_path"].rsplit("/daily_price_full_vintage/",1)[0]+"/training_auxiliary_full_vintage"
    raw=bucket.blob(root+"/manifest.json").download_as_bytes();manifest=json.loads(raw)
    if (manifest.get("schema_version")!="finlab-training-auxiliary-single-capture-v1" or manifest.get("capture_id")!=price_capture["capture_id"] or manifest.get("end_date")!=run_date):
        raise ValueError("root_auxiliary_capture_identity_mismatch")
    ids={str(r["symbol"]):r["id"] for r in stock_rows}
    # Clear stale source values first; keep unrelated point-in-time fields.
    dated={sid:{d:{k:v for k,v in row.items() if k not in (*FIELDS,"short_ratio")} for d,row in rows.items()} for sid,rows in prior_ts.items()}
    chips={sym:[{k:v for k,v in row.items() if k not in {"margin_balance","short_balance"}} for row in rows] for sym,rows in prior_chips.items()}
    chip_keys={sym:{r["date"]:r for r in rows} for sym,rows in chips.items()}
    dates={r["date"] for rows in prices_map.values() for r in rows}
    if not dates:raise ValueError("root_auxiliary_price_keys_empty")
    fields={}
    for field in FIELDS:
        meta=manifest.get("fields",{}).get(field)
        if not meta:raise ValueError("root_auxiliary_field_missing:"+field)
        data=bucket.blob(root+"/"+field+".parquet").download_as_bytes()
        if hashlib.sha256(data).hexdigest()!=meta.get("sha256"):raise ValueError("root_auxiliary_checksum_mismatch:"+field)
        wide=pl.read_parquet(io.BytesIO(data))
        if "date" not in wide.columns:raise ValueError("root_auxiliary_date_missing:"+field)
        wide=wide.with_columns(pl.col("date").cast(pl.String).str.slice(0,10))
        if wide["date"].null_count() or wide["date"].is_duplicated().any():raise ValueError("root_auxiliary_dates_invalid:"+field)
        if wide.height!=meta.get("rows") or set(wide.columns)-{"date"}!=set(meta.get("columns",[])):
            raise ValueError("root_auxiliary_shape_mismatch:"+field)
        if field in DAILY_FIELDS and dates-set(wide["date"].to_list()):
            raise ValueError("root_auxiliary_market_dates_missing:"+field)
        columns=sorted(set(ids)&set(wide.columns))
        values=(wide.select("date",*columns).unpivot(index="date",variable_name="symbol",value_name="value")
            .with_columns(pl.col("value").cast(pl.Float64,strict=True).fill_nan(None)).filter(pl.col("date")<=run_date))
        if values.filter(pl.col("value").is_infinite()).height:raise ValueError("root_auxiliary_nonfinite:"+field)
        history=values.filter(pl.col("date")<min(dates)).filter(pl.col("value").is_not_null()).sort("symbol","date").group_by("symbol",maintain_order=True).tail(1)
        values=pl.concat([history.select(values.columns),values.filter(pl.col("date")>=min(dates))]).sort("symbol","date")
        # Nulls remain recorded in source; native causal sanitizer owns imputation.
        for row in values.iter_rows(named=True):
            dated.setdefault(ids[row["symbol"]],{}).setdefault(row["date"],{})[field]=row["value"]
            if field in {"margin_balance","short_balance"} and row["date"] in chip_keys.get(row["symbol"],{}):
                chip_keys[row["symbol"]][row["date"]][field]=row["value"]
        fields[field]={"sha256":meta["sha256"],"source_rows":wide.height,"selected_rows":values.height,
            "null_count":values["value"].null_count(),"vendor_absent_symbol_columns":sorted(set(ids)-set(columns)),
            "availability":meta.get("availability"),"date_min":wide["date"].min(),"date_max":wide["date"].max()}
    for rows in dated.values():
        for row in rows.values():
            margin,short=row.get("margin_balance"),row.get("short_balance")
            if "margin_balance" in row or "short_balance" in row:
                row["short_ratio"]=short/margin if margin is not None and margin>0 and short is not None else None
    proof={"schema_version":"training-auxiliary-capture-binding-v1","capture_id":manifest["capture_id"],
        "capture_manifest_path":root+"/manifest.json","capture_manifest_sha256":hashlib.sha256(raw).hexdigest(),
        "fields":fields,"financial_value_vintage":manifest.get("financial_value_vintage"),"original_financial_revision_certified":False}
    return dated,chips,proof
