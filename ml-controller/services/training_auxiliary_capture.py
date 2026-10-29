"""Use sealed full vendor auxiliary history, not truncated hot D1 history."""
from __future__ import annotations
import hashlib,io,json
import polars as pl
FIELDS=("margin_balance","short_balance","pe","pb","dividend_yield","revenue","revenue_yoy","revenue_mom","eps","roe","revenue_growth_yoy")
DAILY_FIELDS=frozenset({"margin_balance","short_balance","pe","pb","dividend_yield"})
AUX_FOLDER="training_auxiliary_full_vintage"


def is_sha256(value):
    return isinstance(value,str) and len(value)==64 and all(c in "0123456789abcdef" for c in value)


def sealed_raw_sha(manifest):
    """Vendor sealed-raw receipt when the capture has one; content addressing does not need it."""
    value=manifest.get("sealed_raw_source_sha256")
    return value if is_sha256(value) else None


def select_field_captures(bucket, *, price_capture, run_date):
    """R33: each auxiliary field from its own latest content-addressed capture ending by run_date.

    A partial vendor refresh may write only some fields. Each field is admitted by its
    parquet sha256 (re-verified by the loader); daily fields still must cover every price
    session (checked by the loader), so an old capture cannot go stale silently.
    """
    raw_root=price_capture["capture_manifest_path"].rsplit("/daily_price_full_vintage/",1)[0]
    parent=raw_root.rsplit("/",2)[0]
    own=raw_root+"/"+AUX_FOLDER+"/manifest.json"
    blobs={b.name:b for b in bucket.list_blobs(prefix=parent+"/",match_glob=parent+"/*/raw/"+AUX_FOLDER+"/manifest.json")}
    if own not in blobs and bucket.blob(own).exists():blobs[own]=bucket.blob(own)
    candidates=[]
    for name,blob in blobs.items():
        raw=blob.download_as_bytes();manifest=json.loads(raw)
        if (manifest.get("schema_version")!="finlab-training-auxiliary-single-capture-v1"
                or not manifest.get("capture_id") or str(manifest.get("end_date") or "9999")>run_date):
            continue
        # Same end_date: the price capture's own field wins, so its history matches the price sessions.
        candidates.append(((manifest["end_date"],name==own,manifest["capture_id"]),name,hashlib.sha256(raw).hexdigest(),manifest))
    from services.pit_certification import AUXILIARY_FIELD_DATASETS,load_contract
    datasets=load_contract()["datasets"]
    selected={}
    for field in FIELDS:
        owners=[c for c in candidates if (c[3].get("fields") or {}).get(field)]
        if not owners:raise ValueError("root_auxiliary_field_capture_missing:"+field)
        _,path,sha,manifest=max(owners,key=lambda c:c[0])
        # Fail closed: a corrupt latest owner must not fall back to an older vintage.
        if not is_sha256(manifest["fields"][field].get("sha256")):raise ValueError("root_auxiliary_field_checksum_invalid:"+field)
        selected[field]={"capture_id":manifest["capture_id"],"capture_manifest_path":path,"capture_manifest_sha256":sha,
            "sealed_raw_source_sha256":sealed_raw_sha(manifest),"end_date":manifest["end_date"],
            "financial_value_vintage":manifest.get("financial_value_vintage"),"meta":manifest["fields"][field],
            "availability_level":datasets[AUXILIARY_FIELD_DATASETS[field]]["level"]}
    return selected


def _mask_revised_quarters(bucket,values,capture,mask):
    """Null rows whose active quarter the PIT contract lists as revised (Q4 ii, C28-02 C7).

    The active quarter is the one align_financial_availability selected for that session:
    the latest quarter wins and a late older quarter never overrides it. The feature layer
    then carries the last unrevised value already known, which is point-in-time safe.
    """
    info={"sha256":mask["sha256"],"cells":len(mask["cells"]),"events_sha256":None,"masked_rows":0}
    if not {s for s,_ in mask["cells"]}&set(values["symbol"].unique().to_list()):
        return values,info
    proof=capture["meta"].get("availability_proof") or {}
    path,sha=proof.get("events_path"),proof.get("events_sha256")
    if not path or not is_sha256(sha):raise ValueError("root_auxiliary_revision_events_missing")
    data=bucket.blob(capture["capture_manifest_path"].rsplit("/raw/",1)[0]+"/"+path).download_as_bytes()
    if hashlib.sha256(data).hexdigest()!=sha:raise ValueError("root_auxiliary_revision_events_checksum_mismatch")
    order=pl.col("quarter").str.slice(0,4).cast(pl.Int32)*4+pl.col("quarter").str.slice(6,1).cast(pl.Int32)
    active=(pl.read_parquet(io.BytesIO(data)).filter(pl.col("session").is_not_null())
        .with_columns(pl.col("symbol").cast(pl.String),order.alias("_q"),pl.col("session").cast(pl.Date).alias("_d"))
        .sort("symbol","_d","quarter").with_columns(pl.col("_q").cum_max().over("symbol").alias("_latest"))
        .filter(pl.col("_q")==pl.col("_latest")).unique(["symbol","_d"],keep="last",maintain_order=True)
        .select("symbol","_d","quarter").sort("_d"))
    cells=pl.DataFrame(sorted(mask["cells"]),schema={"symbol":pl.String,"quarter":pl.String},orient="row").with_columns(pl.lit(True).alias("_masked"))
    tagged=(values.with_columns(pl.col("date").str.to_date().alias("_d")).sort("_d")
        .join_asof(active,on="_d",by="symbol",strategy="backward").join(cells,on=["symbol","quarter"],how="left")
        .with_columns(pl.col("_masked").fill_null(False)))
    out=(tagged.with_columns(pl.when(pl.col("_masked")).then(None).otherwise(pl.col("value")).alias("value"))
        .select(values.columns).sort("symbol","date"))
    return out,{**info,"events_sha256":sha,
        "masked_rows":int(tagged.filter(pl.col("_masked")&pl.col("value").is_not_null()).height)}


def load_training_auxiliary_capture(bucket, *, price_capture, stock_rows, prices_map, prior_ts, prior_chips, run_date, inference_composition=None, field_captures=None):
    root=price_capture["capture_manifest_path"].rsplit("/daily_price_full_vintage/",1)[0]+"/training_auxiliary_full_vintage"
    if field_captures is not None:
        manifest={"capture_id":price_capture["capture_id"],"fields":{k:v["meta"] for k,v in field_captures.items()},
                  "financial_value_vintage":"per_field_latest_sealed_capture"}
    elif inference_composition is None:
        raw=bucket.blob(root+"/manifest.json").download_as_bytes();manifest=json.loads(raw)
        if (manifest.get("schema_version")!="finlab-training-auxiliary-single-capture-v1" or manifest.get("capture_id")!=price_capture["capture_id"] or manifest.get("end_date")!=run_date):
            raise ValueError("root_auxiliary_capture_identity_mismatch")
    else:
        from services.daily_inference_composition import read_frame
        manifest={"capture_id":price_capture["capture_id"],"fields":inference_composition["auxiliary"],
                  "financial_value_vintage":"explicit_vendor_baseline_and_incremental_observations"}
    ids={str(r["symbol"]):r["id"] for r in stock_rows}
    # Clear stale source values first; keep unrelated point-in-time fields.
    dated={sid:{d:{k:v for k,v in row.items() if k not in (*FIELDS,"short_ratio")} for d,row in rows.items()} for sid,rows in prior_ts.items()}
    chips={sym:[{k:v for k,v in row.items() if k not in {"margin_balance","short_balance"}} for row in rows] for sym,rows in prior_chips.items()}
    chip_keys={sym:{r["date"]:r for r in rows} for sym,rows in chips.items()}
    dates={r["date"] for rows in prices_map.values() for r in rows}
    if not dates:raise ValueError("root_auxiliary_price_keys_empty")
    masks={}
    if field_captures is not None:
        # R33: revision masks are owned by the PIT contract and verified by sha256.
        from services.pit_certification import load_contract,load_revision_mask
        contract=load_contract()
        masks={f:load_revision_mask(contract,f) for f in (contract.get("revision_masks") or {})}
    fields={}
    for field in FIELDS:
        meta=manifest.get("fields",{}).get(field)
        if not meta:raise ValueError("root_auxiliary_field_missing:"+field)
        if inference_composition is None:
            field_root=field_captures[field]["capture_manifest_path"].rsplit("/",1)[0] if field_captures else root
            data=bucket.blob(field_root+"/"+field+".parquet").download_as_bytes()
            if hashlib.sha256(data).hexdigest()!=meta.get("sha256"):raise ValueError("root_auxiliary_checksum_mismatch:"+field)
            wide=pl.read_parquet(io.BytesIO(data))
        else:
            wide=read_frame(bucket,meta,run_date=run_date)
        if "date" not in wide.columns:raise ValueError("root_auxiliary_date_missing:"+field)
        wide=wide.with_columns(pl.col("date").cast(pl.String).str.slice(0,10))
        if wide["date"].null_count() or wide["date"].is_duplicated().any():raise ValueError("root_auxiliary_dates_invalid:"+field)
        if wide.height!=meta.get("rows") or set(wide.columns)-{"date"}!=set(meta.get("columns",[])) - ({"date"} if inference_composition else set()):
            raise ValueError("root_auxiliary_shape_mismatch:"+field)
        if field in DAILY_FIELDS and dates-set(wide["date"].to_list()):
            raise ValueError("root_auxiliary_market_dates_missing:"+field)
        columns=sorted(set(ids)&set(wide.columns))
        values=(wide.select("date",*columns).unpivot(index="date",variable_name="symbol",value_name="value")
            .with_columns(pl.col("value").cast(pl.Float64,strict=True).fill_nan(None)).filter(pl.col("date")<=run_date))
        if values.filter(pl.col("value").is_infinite()).height:raise ValueError("root_auxiliary_nonfinite:"+field)
        mask_info=None
        if field in masks:
            # Mask before picking the pre-window carry-in, so a revised last value falls back
            # to the latest unrevised one instead of leaving nothing.
            values,mask_info=_mask_revised_quarters(bucket,values,field_captures[field],masks[field])
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
        if mask_info is not None:fields[field]["revision_mask"]=mask_info
    for rows in dated.values():
        for row in rows.values():
            margin,short=row.get("margin_balance"),row.get("short_balance")
            if "margin_balance" in row or "short_balance" in row:
                row["short_ratio"]=short/margin if margin is not None and margin>0 and short is not None else None
    if field_captures is not None:
        return dated,chips,{"schema_version":"training-auxiliary-capture-binding-v2-per-field","capture_id":manifest["capture_id"],
            "field_captures":{k:{key:v.get(key) for key in ("capture_id","capture_manifest_path","capture_manifest_sha256","sealed_raw_source_sha256","end_date","availability_level")}
                              for k,v in field_captures.items()},
            "fields":fields,"financial_value_vintage":manifest["financial_value_vintage"],"original_financial_revision_certified":False}
    proof={"schema_version":"inference-auxiliary-composition-binding-v1" if inference_composition else "training-auxiliary-capture-binding-v1","capture_id":manifest["capture_id"],
        "capture_manifest_path":inference_composition["manifest_path"] if inference_composition else root+"/manifest.json",
        "capture_manifest_sha256":inference_composition["manifest_sha256"] if inference_composition else hashlib.sha256(raw).hexdigest(),
        "fields":fields,"financial_value_vintage":manifest.get("financial_value_vintage"),"original_financial_revision_certified":False}
    return dated,chips,proof
