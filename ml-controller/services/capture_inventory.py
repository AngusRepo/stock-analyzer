"""Collect capture contract gaps before stock loading or indicator computation.

This checks manifests and object presence. Existing value, calendar, availability,
feature and model admission checks remain mandatory after this inventory passes.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date

from services.training_auxiliary_capture import DAILY_FIELDS, FIELDS
from services.training_source_preflight import _sealed_manifest


def inspect_capture_inventory(bucket, *, sequence_gcs_prefix: str, run_date: str, inference_only: bool = False) -> dict:
    sequence = _sealed_manifest(bucket, sequence_gcs_prefix, "sequence_manifest.json", compact=True)
    daily = [r for r in sequence.get("lane_reports", []) if r.get("lane") == "daily_price"]
    if len(daily) != 1 or not isinstance(daily[0].get("source_uri"), dict):
        raise ValueError("capture_inventory_single_price_source_required")
    source = daily[0]["source_uri"]
    uri = source.get("close", "")
    if (not uri.startswith(f"gs://{bucket.name}/")
            or not uri.endswith(("/daily_price_full_vintage/close.parquet", "/daily_price_full_vintage/adj_close.parquet"))):
        raise ValueError("capture_inventory_price_uri_invalid")
    price_root = uri.split("/", 3)[3].rsplit("/", 1)[0]
    raw_root = price_root.rsplit("/", 1)[0]
    # One bounded prefix listing, not one API request per missing file.
    present = {blob.name for blob in bucket.list_blobs(prefix=raw_root + "/")}
    issues, manifests = [], {}

    def issue(code, path, **extra):
        issues.append({"code": code, "path": path, **extra})

    def require_file(path):
        if path not in present:
            issue("object_missing", path)

    def manifest(folder, filename, schema, *, end_key="end_date"):
        path = f"{raw_root}/{folder}/{filename}"
        if path not in present:
            issue("manifest_missing", path)
            return {}
        raw = bucket.blob(path).download_as_bytes()
        manifests[path] = hashlib.sha256(raw).hexdigest()
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            issue("manifest_invalid_json", path)
            return {}
        if not isinstance(value, dict):
            issue("manifest_invalid_shape", path)
            return {}
        if value.get("schema_version") != schema:
            issue("manifest_schema_mismatch", path)
        if value.get("capture_id") != source.get("capture_id") or not source.get("capture_id"):
            issue("capture_identity_mismatch", path)
        if value.get(end_key) != run_date:
            issue("capture_date_mismatch", path, expected=run_date, actual=value.get(end_key))
        return value

    def sha_required(value, path, field):
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            issue("field_checksum_missing_or_invalid", path, field=field)

    price = manifest("daily_price_full_vintage", "manifest.json", "finlab-adjusted-price-single-capture-v1")
    for field in ("open", "high", "low", "close", "volume", "value", "adj_close", "adj_open", "market_value"):
        path = f"{price_root}/{field}.parquet"
        require_file(path)
        sha_required(price.get("checksums", {}).get(field), path, field)
    for field in ("adj_close", "adj_open"):
        if price.get("checksums", {}).get(field) != source.get("checksums", {}).get(field):
            issue("sequence_price_checksum_mismatch", price_root + "/manifest.json", field=field)
    for filename in ("training_calendar.json", "training_breadth.json"):
        require_file(price_root + "/" + filename)
    # Legacy price manifests omit a history start. Verify and project only the
    # close date column; no indicators or per-stock Python panels are built.
    price_start = price.get("start_date")
    close_path = price_root + "/close.parquet"
    if not price_start and close_path in present:
        import io
        import polars as pl
        raw = bucket.blob(close_path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != price.get("checksums", {}).get("close"):
            issue("price_calendar_content_checksum_mismatch", close_path)
        else:
            try:
                days = pl.read_parquet(io.BytesIO(raw), columns=["date"])["date"].cast(pl.String).str.slice(0, 10)
                if not len(days) or days.null_count() or days.is_duplicated().any():
                    raise ValueError("empty, duplicate or null dates")
                for day in days:
                    date.fromisoformat(day)
                price_start = days.min()
            except (ValueError, TypeError, pl.exceptions.PolarsError):
                issue("price_calendar_dates_invalid", close_path)

    folder = "chip_diversity_full_vintage"
    institutional = manifest(folder, "manifest.json", "finlab-institutional-single-capture-v1")
    for field in ("foreign_net", "trust_net", "dealer_self_net", "dealer_hedge_net"):
        path = f"{raw_root}/{folder}/{field}.parquet"
        require_file(path)
        sha_required(institutional.get("checksums", {}).get(field), path, field)

    composition = None
    if inference_only:
        from services.daily_inference_composition import load_composition, read_frame
        composition = load_composition(bucket, price_capture={
            "capture_id":source["capture_id"],
            "capture_manifest_sha256":manifests.get(price_root+"/manifest.json")},run_date=run_date)
    if composition is not None:
        for group in ("auxiliary", "long"):
            for field, item in composition[group].items():
                try:
                    frame=read_frame(bucket,item,run_date=run_date)
                    if field in DAILY_FIELDS and price_start and frame["date"].min()>price_start:
                        issue("daily_history_starts_after_price_capture",item["path"],field=field)
                except Exception as exc:
                    issue("composition_field_invalid",item.get("path"),field=field,detail=str(exc))
        return {"schema_version":"capture-inventory-preflight-v1",
                "status":"blocked" if issues else "inventory_ready",
                "capture_id":source["capture_id"],"business_date":run_date,
                "sequence_manifest_checksum":sequence["manifest_checksum"],
                "manifest_sha256":manifests,"issues":issues,
                "inference_composition_sha256":composition["manifest_sha256"],
                "value_validation_complete":False,"model_admitted":False}

    folder = "training_auxiliary_full_vintage"
    auxiliary = manifest(folder, "manifest.json", "finlab-training-auxiliary-single-capture-v1")
    for field in FIELDS:
        path = f"{raw_root}/{folder}/{field}.parquet"
        require_file(path)
        spec = (auxiliary.get("fields") or {}).get(field) or {}
        sha_required(spec.get("sha256"), path, field)
        if field in DAILY_FIELDS and spec and price_start:
            try:
                if date.fromisoformat(spec["start_date"]) > date.fromisoformat(price_start):
                    issue("daily_history_starts_after_price_capture", path,
                          price_start=price_start, source_start=spec["start_date"])
            except (KeyError, TypeError, ValueError):
                issue("daily_history_start_invalid", path)

    folder = "training_long_full_vintage"
    for name in ("broker", "holding"):
        meta = manifest(folder, name + ".json", "training-long-source-capture-v1", end_key="end")
        path = f"{raw_root}/{folder}/{name}.parquet"
        require_file(path)
        sha_required(meta.get("sha256"), path, name)
        if meta and meta.get("source") != name:
            issue("long_source_owner_mismatch", path)

    return {"schema_version": "capture-inventory-preflight-v1",
            "status": "blocked" if issues else "inventory_ready",
            "capture_id": source.get("capture_id"), "business_date": run_date,
            "sequence_manifest_checksum": sequence["manifest_checksum"],
            "manifest_sha256": manifests, "issues": issues,
            "value_validation_complete": False, "model_admitted": False}
