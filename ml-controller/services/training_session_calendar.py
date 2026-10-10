"""Independent official sessions for a complete training price capture."""
import hashlib
import io
import json
from datetime import date

import polars as pl


def official_month_sessions(body, market, month):
    if not isinstance(body, dict) or body.get("date") != month.replace("-", "") + "01":
        raise ValueError("training_calendar_response_month_mismatch")
    if market == "TWSE":
        if body.get("stat") != "OK": raise ValueError("training_calendar_official_unavailable")
        rows = body.get("data") or []
    elif market == "TPEX":
        tables = [t for t in body.get("tables", []) if (t.get("fields") or [None])[0] == "日期"]
        if len(tables) != 1: raise ValueError("training_calendar_official_table_missing")
        rows = tables[0].get("data") or []
        if len(rows) != tables[0].get("totalCount"): raise ValueError("training_calendar_official_rows_missing")
    else:
        raise ValueError("training_calendar_market_invalid")
    sessions = []
    for row in rows:
        year, mon, day = map(int, row[0].split("/"))
        if year < 1911: year += 1911
        value = date(year, mon, day).isoformat()
        if value[:7] != month or float(str(row[4]).replace(",", "")) <= 0:
            raise ValueError("training_calendar_official_row_invalid")
        sessions.append(value)
    if not sessions or len(sessions) != len(set(sessions)):
        raise ValueError("training_calendar_official_dates_invalid")
    return sorted(sessions)


def price_session_dates(raw):
    frame = pl.read_parquet(io.BytesIO(raw))
    if "date" not in frame.columns or frame.height == 0: raise ValueError("training_calendar_prices_empty")
    dates = frame.select(pl.col("date").cast(pl.String).str.slice(0, 10))["date"]
    if dates.null_count() or dates.is_duplicated().any(): raise ValueError("training_calendar_price_dates_invalid")
    columns = [c for c in frame.columns if c != "date"]
    counts = frame.select(pl.sum_horizontal([
        (pl.col(c).cast(pl.Float64).is_finite() & (pl.col(c).cast(pl.Float64) > 0)).fill_null(False).cast(pl.Int32)
        for c in columns]).alias("n"))["n"]
    return sorted(d for d, n in zip(dates, counts, strict=True) if n >= 100)


def require_session_equality(observed, official, *, start, end):
    if not start or not end or start > end: raise ValueError("training_calendar_window_invalid")
    actual = set(d for d in observed if start <= d <= end)
    if not actual: raise ValueError("training_calendar_prices_empty")
    for market in ("TWSE", "TPEX"):
        expected = set(d for d in official.get(market, []) if start <= d <= end)
        if not expected or actual != expected:
            raise ValueError("training_calendar_session_gap:" + market + ":" + json.dumps({
                "missing": sorted(expected - actual), "unexpected": sorted(actual - expected)}))


def verify_training_calendar(bucket, *, price_capture):
    manifest_path = price_capture.get("capture_manifest_path")
    if not manifest_path: raise ValueError("training_calendar_capture_required")
    root = manifest_path.rsplit("/", 1)[0]
    raw = bucket.blob(manifest_path).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != price_capture.get("capture_manifest_sha256"):
        raise ValueError("training_calendar_capture_changed")
    manifest = json.loads(raw)
    expected = manifest.get("official_calendar_sha256")
    if not expected: raise ValueError("training_calendar_official_required")
    raw = bucket.blob(root + "/training_calendar.json").download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != expected: raise ValueError("training_calendar_checksum_mismatch")
    receipt = json.loads(raw)
    if (receipt.get("schema_version") != "official-training-calendar-v1"
            or receipt.get("capture_id") != price_capture.get("capture_id")
            or receipt.get("end") != manifest.get("end_date")
            or receipt.get("close_sha256") != manifest.get("checksums", {}).get("close")):
        raise ValueError("training_calendar_binding_mismatch")
    sessions = {"TWSE": [], "TPEX": []}
    seen = set()
    for item in receipt.get("sources", []):
        market, month = item["market"], item["month"]
        if market not in sessions or (market, month) in seen: raise ValueError("training_calendar_source_duplicate")
        # Reconstruct the path; source data cannot redirect the reader elsewhere.
        date.fromisoformat(month + "-01")
        data = bucket.blob(root + f"/official_calendar/{market}-{month}.json").download_as_bytes()
        if hashlib.sha256(data).hexdigest() != item.get("sha256"): raise ValueError("training_calendar_source_changed")
        sessions[market].extend(official_month_sessions(json.loads(data), market, month))
        seen.add((market, month))
    raw = bucket.blob(root + "/close.parquet").download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != receipt["close_sha256"]: raise ValueError("training_calendar_price_changed")
    observed = price_session_dates(raw)
    require_session_equality(observed, sessions, start=receipt["start"], end=receipt["end"])
    if receipt["start"] != min(observed): raise ValueError("training_calendar_truncated_start")
    return {"schema_version": "verified-training-calendar-v1", "capture_id": receipt["capture_id"],
        "start": receipt["start"], "end": receipt["end"], "sessions": len(observed),
        "calendar_sha256": expected, "close_sha256": receipt["close_sha256"]}
