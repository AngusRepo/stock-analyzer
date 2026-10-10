"""Dated candidate + held-only risk inputs; never enlarge the L3 decision pool."""
from datetime import date
import math


def load_held_risk_payloads(*, holdings, payloads, signal_date, lookback):
    from services.domain_stock_read_models import load_core_stock_identities
    from services.payload_builder import _bulk_load_prices
    present = {str(row.get("symbol") or row.get("stock_id")) for row in payloads}
    needed = sorted({row["symbol"] for row in holdings} - present)
    if not needed:
        return []
    identities = load_core_stock_identities(tradable_only=False)
    by_symbol = {row["symbol"]: sid for sid, row in identities.items()}
    if any(symbol not in by_symbol for symbol in needed):
        raise ValueError("l4_risk_held_identity_missing")
    prices = _bulk_load_prices([by_symbol[s] for s in needed], limit=lookback + 1, as_of_date=signal_date)
    return [{"symbol": s, "stock_id": by_symbol[s], "prices": prices.get(by_symbol[s], []),
             "source": "market.stock_prices.adj_close", "as_of_date": signal_date,
             "role": "held_only_risk_not_l3_candidate"} for s in needed]


def aligned_dated_history(payloads, *, signal_date, lookback):
    """Match exact return intervals; tail lengths cannot establish time alignment."""
    cutoff = date.fromisoformat(signal_date)
    series = {}
    for payload in payloads:
        symbol = str(payload.get("symbol") or payload.get("stock_id") or "")
        if not symbol or symbol in series:
            raise ValueError("l4_risk_duplicate_or_missing_symbol")
        prices = {}
        for row in payload.get("prices") or []:
            day = str(row.get("date") or "")[:10]
            if date.fromisoformat(day) > cutoff:
                raise ValueError("paired_nav_allocator_history_future_price")
            value = float(row.get("adj_close") or 0)
            if day in prices or not math.isfinite(value) or value <= 0:
                raise ValueError("l4_risk_adjusted_price_invalid")
            prices[day] = value
        days = sorted(prices)[-(lookback + 1):]
        series[symbol] = {(left, right): round(prices[right] / prices[left] - 1, 8)
                          for left, right in zip(days, days[1:])}
    common = sorted(set.intersection(*(set(values) for values in series.values()))) if series else []
    if len(common) < 20:
        raise ValueError("l4_risk_aligned_history_insufficient")
    return {symbol: [values[interval] for interval in common] for symbol, values in series.items()}, [list(x) for x in common]


def load_canonical_risk_payloads(*,payloads,held_payloads,signal_date,lookback,query=None,capture_source=None,bucket=None):
    """Read the canonical owner on every new decision, including later backfills.

    Risk inputs are separate from L3 feature payloads. A legacy mirror gap or
    raw-price overwrite cannot prevent an available canonical quote being used.
    """
    if query is None:
        return _load_capture_risk_payloads(payloads=payloads,held_payloads=held_payloads,
            signal_date=signal_date,lookback=lookback,capture_source=capture_source,bucket=bucket)
    # Explicit query injection retains the legacy diagnostic replay adapter.
    # Live callers do not supply it and must use a sealed capture.
    from services.d1_domain_client import client_proxy_for_domain
    all_rows=[*payloads,*held_payloads];symbols=[str(p.get('symbol') or '') for p in all_rows]
    if any(not s for s in symbols) or len(set(symbols))!=len(symbols):raise ValueError('l4_risk_duplicate_or_missing_symbol')
    date.fromisoformat(signal_date)
    days=sorted({str(r['date'])[:10] for p in all_rows for r in p.get('prices') or [] if str(r['date'])[:10]<=signal_date})
    if len(days)<21:raise ValueError('l4_risk_calendar_insufficient')
    first=days[-min(len(days),lookback+1)]
    read=query or client_proxy_for_domain('market').query
    canonical={s:{} for s in symbols}
    for offset in range(0,len(symbols),60):
        chunk=symbols[offset:offset+60];marks=','.join('?' for _ in chunk)
        rows=read(f"SELECT stock_id,date,adj_close,source FROM canonical_market_daily WHERE stock_id IN ({marks}) "
            "AND date>=? AND date<=? AND source IN ('finlab.price','finlab.rotc_price') ORDER BY stock_id,date,source",
            [*chunk,first,signal_date],timeout=120.0)
        for row in rows:
            symbol=str(row['stock_id']);day=str(row['date'])[:10]
            if symbol not in chunk or not first<=day<=signal_date:raise ValueError('l4_risk_canonical_read_boundary')
            value=row.get('adj_close');valid=value is not None and math.isfinite(float(value)) and float(value)>0
            current=canonical[symbol].get(day)
            priority=0 if row['source']=='finlab.price' else 1
            if current is None or priority<current['priority']:
                canonical[symbol][day]={'date':day,'adj_close':float(value) if valid else None,'priority':priority}
            elif priority==current['priority'] and current['adj_close']!=(float(value) if valid else None):
                raise ValueError('l4_risk_conflicting_canonical_price')
    output=[]
    for original in all_rows:
        symbol=str(original['symbol']);rows=canonical[symbol]
        # Keep calendar rows even where neither source has a valid price.
        risk_days=sorted(set(rows)|{str(p['date'])[:10] for p in original.get('prices') or [] if first<=str(p['date'])[:10]<=signal_date})
        output.append({'symbol':symbol,'stock_id':original.get('stock_id'),
            'prices':[{'date':d,'adj_close':rows.get(d,{}).get('adj_close')} for d in risk_days],
            'source':'market.canonical_market_daily.adj_close','as_of_date':signal_date,'role':'canonical_risk_only',
            'canonical_rows':len(rows),'legacy_price_fallback':False})
    return output


def _load_capture_risk_payloads(*,payloads,held_payloads,signal_date,lookback,capture_source,bucket=None):
    import hashlib,io,json
    import polars as pl
    from services.training_source_preflight import _sealed_manifest
    if (not isinstance(capture_source,dict) or capture_source.get("status")!="ready"
            or capture_source.get("signal_date")!=signal_date):
        raise ValueError("l4_risk_single_capture_source_required")
    if type(lookback) is not int or not 20<=lookback<=504:raise ValueError("l4_risk_lookback_invalid")
    if bucket is None:
        from services.walk_forward_retrain import _get_bucket
        bucket=_get_bucket()
    if bucket is None:raise ValueError("l4_risk_capture_bucket_missing")
    prefix=str(capture_source.get("source_gcs_prefix") or "")
    receipt=json.loads(bucket.blob(f"{prefix}/prep/immutable_receipt.json").download_as_bytes())
    unsigned={k:v for k,v in receipt.items() if k!="receipt_checksum"}
    checksum=hashlib.sha256(json.dumps(unsigned,sort_keys=True).encode()).hexdigest()
    if (checksum!=receipt.get("receipt_checksum") or checksum!=capture_source.get("source_receipt_checksum")
            or receipt.get("business_date")!=signal_date or receipt.get("status")!="ready"
            or receipt.get("output_gcs_prefix")!=prefix):
        raise ValueError("l4_risk_feature_receipt_mismatch")
    proof=receipt.get("price_capture") or {}
    seq=_sealed_manifest(bucket,str(capture_source.get("sequence_gcs_prefix") or ""),"sequence_manifest.json",compact=True)
    if proof.get("sequence_manifest_checksum")!=seq["manifest_checksum"]:
        raise ValueError("l4_risk_sequence_capture_mismatch")
    daily=[r for r in seq.get("lane_reports",[]) if r.get("lane")=="daily_price"]
    source=daily[0].get("source_uri",{}) if len(daily)==1 else {}
    path=str(proof.get("capture_manifest_path") or "")
    if (proof.get("schema_version")!="training-price-capture-binding-v1" or not path
            or source.get("capture_id")!=proof.get("capture_id")
            or not str(source.get("close") or "").startswith(f"gs://{bucket.name}/")
            or source.get("checksums",{}).get("adj_close")!=proof.get("checksums",{}).get("adj_close")):
        raise ValueError("l4_risk_price_capture_mismatch")
    manifest_raw=bucket.blob(path).download_as_bytes();manifest=json.loads(manifest_raw)
    if (hashlib.sha256(manifest_raw).hexdigest()!=proof.get("capture_manifest_sha256")
            or manifest.get("capture_id")!=proof["capture_id"] or manifest.get("end_date")!=signal_date):
        raise ValueError("l4_risk_capture_manifest_mismatch")
    close_path=path.rsplit("/",1)[0]+"/adj_close.parquet"
    if source["close"]!=f"gs://{bucket.name}/{close_path}":raise ValueError("l4_risk_capture_path_mismatch")
    raw=bucket.blob(close_path).download_as_bytes();sha=hashlib.sha256(raw).hexdigest()
    if sha!=proof["checksums"]["adj_close"] or sha!=manifest["checksums"]["adj_close"]:
        raise ValueError("l4_risk_capture_price_checksum_mismatch")
    frame=pl.read_parquet(io.BytesIO(raw)).with_columns(pl.col("date").cast(pl.String).str.slice(0,10))
    if frame["date"].null_count() or frame["date"].is_duplicated().any():raise ValueError("l4_risk_capture_dates_invalid")
    frame=frame.filter(pl.col("date")<=signal_date).sort("date").tail(lookback+1)
    if frame.is_empty() or frame["date"].max()!=signal_date:raise ValueError("l4_risk_capture_stale")
    rows=[*payloads,*held_payloads];symbols=[str(p.get("symbol") or "") for p in rows]
    if any(not s for s in symbols) or len(set(symbols))!=len(symbols):raise ValueError("l4_risk_duplicate_or_missing_symbol")
    identity={"capture_id":proof["capture_id"],"capture_manifest_sha256":proof["capture_manifest_sha256"],
        "adj_close_sha256":sha,"sequence_manifest_checksum":seq["manifest_checksum"],"feature_receipt_checksum":checksum}
    output=[]
    for original,symbol in zip(rows,symbols,strict=True):
        values=frame[symbol].to_list() if symbol in frame.columns else [None]*frame.height
        prices=[{"date":day,"adj_close":float(v) if v is not None and math.isfinite(float(v)) and float(v)>0 else None}
                for day,v in zip(frame["date"].to_list(),values,strict=True)]
        output.append({"symbol":symbol,"stock_id":original.get("stock_id"),"prices":prices,
            "source":"finlab.full_adjustment_capture.adj_close","as_of_date":signal_date,
            "role":"canonical_risk_only","price_capture":identity,"legacy_price_fallback":False})
    return output
