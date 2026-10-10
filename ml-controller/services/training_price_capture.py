"""Bind actual root price values to the same sealed capture as sequence labels."""
from __future__ import annotations
import hashlib
import io
import json
import polars as pl
from services.training_source_preflight import _sealed_manifest

PRICE_FIELDS = ("open", "high", "low", "close", "volume", "value", "adj_close", "adj_open")


def load_training_price_capture(bucket, *, sequence_gcs_prefix: str, stock_rows: list[dict],
                                prices_lookback: int, run_date: str, prior_prices: dict,
                                prior_indicators: dict) -> tuple[dict, dict, dict]:
    seq=_sealed_manifest(bucket,sequence_gcs_prefix,"sequence_manifest.json",compact=True)
    daily=[x for x in seq.get("lane_reports",[]) if x.get("lane")=="daily_price"]
    if len(daily)!=1 or not isinstance(daily[0].get("source_uri"),dict):
        raise ValueError("root_price_single_capture_required")
    source=daily[0]["source_uri"]
    uri=source.get("close")
    if not source.get("capture_id") or not isinstance(uri,str) or not uri.startswith(f"gs://{bucket.name}/"):
        raise ValueError("root_price_single_capture_required")
    prefix=uri.removeprefix(f"gs://{bucket.name}/").rsplit("/",1)[0]
    raw_manifest=bucket.blob(f"{prefix}/manifest.json").download_as_bytes()
    manifest=json.loads(raw_manifest)
    if manifest.get("schema_version")!="finlab-adjusted-price-single-capture-v1" or manifest.get("capture_id")!=source["capture_id"] or manifest.get("end_date")!=run_date:
        raise ValueError("root_price_capture_identity_or_date_mismatch")
    if any(manifest.get("checksums",{}).get(k)!=source.get("checksums",{}).get(k) for k in ("adj_close","adj_open")):
        raise ValueError("root_price_sequence_checksum_mismatch")
    from services.training_price_venue_scope import scope_from_manifest, compare_prior_scope
    venue_entries, venue_sha = scope_from_manifest(manifest)
    stock_markets = {str(row["symbol"]): row.get("market") for row in stock_rows}
    venue_comparisons = []
    ids={str(row["symbol"]):row["id"] for row in stock_rows}
    if len(ids)!=len(stock_rows) or len(set(ids.values()))!=len(ids):
        raise ValueError("root_price_stock_identity_duplicate")
    frames=[];checksums={}
    for field in PRICE_FIELDS:
        expected=manifest.get("checksums",{}).get(field)
        if not isinstance(expected,str) or len(expected)!=64:
            raise ValueError(f"root_price_capture_field_missing:{field}")
        raw=bucket.blob(f"{prefix}/{field}.parquet").download_as_bytes()
        if hashlib.sha256(raw).hexdigest()!=expected:
            raise ValueError(f"root_price_capture_checksum_mismatch:{field}")
        wide=pl.read_parquet(io.BytesIO(raw))
        if "date" not in wide.columns:raise ValueError("root_price_capture_date_missing")
        wide=wide.with_columns(pl.col("date").cast(pl.String).str.slice(0,10))
        if wide["date"].is_duplicated().any() or wide["date"].null_count():
            raise ValueError("root_price_capture_duplicate_or_null_dates")
        missing=sorted(set(ids)-set(wide.columns))
        if missing:raise ValueError(f"root_price_capture_symbol_columns_missing:{field}:{','.join(missing)}")
        cols=sorted(ids)
        frame=(wide.select("date",*cols).unpivot(index="date",variable_name="symbol",value_name=field)
               .with_columns(pl.col(field).cast(pl.Float64,strict=False).fill_nan(None)).filter(pl.col("date")<=run_date))
        if frame.filter(pl.col(field).is_infinite()).height:
            raise ValueError(f"root_price_capture_nonfinite:{field}")
        frames.append(frame);checksums[field]=expected
    frame=frames[3]  # raw close is the bar-presence owner; no old rows resurrected.
    for index,part in enumerate(frames):
        if index!=3:frame=frame.join(part,on=["date","symbol"],how="left",validate="1:1")
    frame=frame.filter(pl.col("close").is_finite() & (pl.col("close")>0))
    if frame.is_empty() or frame.filter(~pl.col("adj_close").is_finite() | pl.col("adj_close").is_null() | (pl.col("adj_close")<=0)).height:
        raise ValueError("root_price_capture_adjustment_incomplete")
    frame=frame.with_columns(pl.when(pl.col("volume")>0).then(pl.col("value")/pl.col("volume")).otherwise(None).alias("avg_price"))
    frame=frame.sort("symbol","date").group_by("symbol",maintain_order=True).tail(prices_lookback)
    grouped=frame.partition_by("symbol",as_dict=True)
    prices={};indicators=dict(prior_indicators);recomputed=[];unavailable=[]
    for symbol,stock_id in ids.items():
        part=grouped.get((symbol,))
        rows=part.drop("symbol").to_dicts() if part is not None else []
        previous=prior_prices.get(stock_id,[])
        previous_count = len(previous)
        if symbol in venue_entries:
            previous_count, comparison = compare_prior_scope(venue_entries[symbol], symbol=symbol,
                market=stock_markets[symbol], previous=previous, rows=rows)
            venue_comparisons.append(comparison)
        if previous_count>=60 and len(rows)<60:
            raise ValueError(f"root_price_capture_lost_eligible_symbol:{symbol}")
        if not rows:unavailable.append(symbol)
        prices[stock_id]=rows
        recomputed.append(symbol)
    from services.training_indicator_capture import rebuild_capture_indicators
    indicators,indicator_proof=rebuild_capture_indicators(prices)
    value_rows=frame.select("symbol","date",*PRICE_FIELDS).sort("symbol","date")
    proof={"schema_version":"training-price-capture-binding-v1","capture_id":source["capture_id"],
        "capture_manifest_path":f"{prefix}/manifest.json","capture_manifest_sha256":hashlib.sha256(raw_manifest).hexdigest(),
        "checksums":checksums,"sequence_manifest_checksum":seq["manifest_checksum"],
        "actual_price_values_sha256":hashlib.sha256(value_rows.write_json().encode()).hexdigest(),
        "rows":frame.height,"symbols":frame["symbol"].n_unique(),"requested_symbols":len(ids),
        "date_min":frame["date"].min(),"date_max":frame["date"].max(),
        "source_null_counts":{k:frame[k].null_count() for k in PRICE_FIELDS},
        "indicator_capture":indicator_proof,"symbols_without_price_rows":unavailable,"indicators_recomputed_symbols":recomputed,
        "prior_venue_scope_sha256":venue_sha,"prior_venue_comparisons":venue_comparisons,
        "historical_financial_vintages_certified":False}
    return prices,indicators,proof


INSTITUTIONAL_FIELDS = ("foreign_net", "trust_net", "dealer_self_net", "dealer_hedge_net")


def load_training_institutional_capture(bucket, *, price_capture: dict, run_date: str,
                                        stock_rows: list[dict], prices_map: dict, prior_chips: dict):
    root=price_capture["capture_manifest_path"].rsplit("/daily_price_full_vintage/",1)[0]+"/chip_diversity_full_vintage"
    raw=bucket.blob(f"{root}/manifest.json").download_as_bytes();manifest=json.loads(raw)
    if (manifest.get("schema_version")!="finlab-institutional-single-capture-v1"
            or manifest.get("capture_id")!=price_capture["capture_id"] or manifest.get("end_date")!=run_date):
        raise ValueError("root_institutional_capture_identity_mismatch")
    keys=[{"symbol":str(s["symbol"]),"date":row["date"]} for s in stock_rows for row in prices_map.get(s["id"],[])]
    if not keys:raise ValueError("root_institutional_price_keys_empty")
    frame=pl.DataFrame(keys);symbols=set(frame["symbol"].to_list());checksums={}
    for field in INSTITUTIONAL_FIELDS:
        expected=manifest.get("checksums",{}).get(field)
        if not expected:raise ValueError(f"root_institutional_field_missing:{field}")
        data=bucket.blob(f"{root}/{field}.parquet").download_as_bytes()
        if hashlib.sha256(data).hexdigest()!=expected:raise ValueError(f"root_institutional_checksum_mismatch:{field}")
        wide=pl.read_parquet(io.BytesIO(data)).with_columns(pl.col("date").cast(pl.String).str.slice(0,10))
        if wide["date"].is_duplicated().any() or wide["date"].null_count():raise ValueError("root_institutional_duplicate_or_null_dates")
        missing=sorted(symbols-set(wide.columns))
        if missing:raise ValueError(f"root_institutional_symbol_columns_missing:{field}:{','.join(missing)}")
        cols=sorted(symbols)
        values=(wide.select("date",*cols).unpivot(index="date",variable_name="symbol",value_name=field)
                .with_columns(pl.col(field).cast(pl.Float64,strict=False).fill_nan(None)))
        if values.filter(pl.col(field).is_infinite()).height:raise ValueError("root_institutional_nonfinite")
        frame=frame.join(values,on=["date","symbol"],how="left",validate="1:1")
        if frame[field].null_count()==frame.height:raise ValueError(f"root_institutional_entire_field_missing:{field}")
        checksums[field]=expected
    frame=frame.with_columns((pl.col("dealer_self_net")+pl.col("dealer_hedge_net")).alias("dealer_net")).sort("symbol","date")
    chips={}
    for (symbol,),part in frame.partition_by("symbol",as_dict=True).items():
        old={str(row["date"])[:10]:row for row in prior_chips.get(symbol,[])}
        chips[symbol]=[{**old.get(row["date"],{}),**row} for row in part.drop("symbol").to_dicts()]
    proof={"schema_version":"training-institutional-capture-binding-v1","capture_id":manifest["capture_id"],
        "capture_manifest_path":f"{root}/manifest.json","capture_manifest_sha256":hashlib.sha256(raw).hexdigest(),
        "checksums":checksums,"actual_values_sha256":hashlib.sha256(frame.write_json().encode()).hexdigest(),
        "rows":frame.height,"source_null_counts":{k:frame[k].null_count() for k in INSTITUTIONAL_FIELDS},
        "missing_value_policy":"preserve vendor nulls; never resurrect old root values or reinterpret zero"}
    return chips,proof

def load_training_market_cap_capture(bucket, *, price_capture, stock_rows, prices_map, prior_ts):
    """Use dated vendor market value; never a current scalar for historical rows."""
    manifest_path=price_capture["capture_manifest_path"]
    raw=bucket.blob(manifest_path).download_as_bytes()
    if hashlib.sha256(raw).hexdigest()!=price_capture["capture_manifest_sha256"]:
        raise ValueError("root_market_cap_manifest_mismatch")
    manifest=json.loads(raw);expected=manifest.get("checksums",{}).get("market_value")
    if not expected:raise ValueError("root_market_cap_source_required")
    path=manifest_path.rsplit("/",1)[0]+"/market_value.parquet"
    raw=bucket.blob(path).download_as_bytes()
    if hashlib.sha256(raw).hexdigest()!=expected:raise ValueError("root_market_cap_checksum_mismatch")
    wide=pl.read_parquet(io.BytesIO(raw)).with_columns(pl.col("date").cast(pl.String).str.slice(0,10))
    if wide["date"].null_count() or wide["date"].is_duplicated().any():raise ValueError("root_market_cap_dates_invalid")
    ids={str(s["symbol"]):s["id"] for s in stock_rows}
    cols=sorted(set(wide.columns)&set(ids))
    vendor_absent_symbols=sorted(set(ids)-set(wide.columns))
    source_cols=[c for c in wide.columns if c!="date"]
    if not source_cols or not wide.select(pl.any_horizontal(pl.col(source_cols).cast(pl.Float64,strict=True).is_finite().fill_null(False)).any()).item():
        raise ValueError("root_market_cap_entire_field_missing")
    values=(wide.select("date",*cols).unpivot(index="date",variable_name="symbol",value_name="market_cap_proxy")
            .with_columns(pl.col("market_cap_proxy").cast(pl.Float64,strict=True).fill_nan(None)))
    if values.filter(pl.col("market_cap_proxy").is_infinite() | (pl.col("market_cap_proxy")<0)).height:
        raise ValueError("root_market_cap_values_invalid")
    keys=pl.DataFrame([{"symbol":s,"date":r["date"]} for s,sid in ids.items() for r in prices_map.get(sid,[])])
    frame=keys.join(values,on=["symbol","date"],how="left",validate="1:1").sort("symbol","date")
    if not frame.height:raise ValueError("root_market_cap_price_keys_empty")
    # Remove stale cap values, while preserving unrelated dated financial fields.
    result={sid:{d:{k:v for k,v in row.items() if k!="market_cap_proxy"} for d,row in dates.items()}
            for sid,dates in prior_ts.items()}
    for row in frame.iter_rows(named=True):
        result.setdefault(ids[row["symbol"]],{}).setdefault(row["date"],{})["market_cap_proxy"]=row["market_cap_proxy"]
    proof={"schema_version":"training-market-cap-capture-binding-v1","capture_id":price_capture["capture_id"],
           "capture_manifest_sha256":price_capture["capture_manifest_sha256"],"market_value_sha256":expected,
           "actual_values_sha256":hashlib.sha256(frame.write_json().encode()).hexdigest(),"rows":frame.height,
           "source_null_count":frame["market_cap_proxy"].null_count(),
           "vendor_absent_symbol_columns":vendor_absent_symbols,
           "missing_value_policy":"sealed vendor absent columns and nulls retained; no scalar or zero backfill",
           "date_min":frame["date"].min(),"date_max":frame["date"].max()}
    return result,proof
