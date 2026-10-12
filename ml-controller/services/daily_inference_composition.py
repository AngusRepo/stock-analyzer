"""Explicit vendor baseline/delta lineage for inference; never training admission."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import polars as pl

SCHEMA = "daily-inference-source-composition-v1"


def read_verified(bucket, item):
    path, expected = item.get("path"), item.get("sha256")
    if (not isinstance(path, str) or not path or path.startswith("/")
            or ".." in path.split("/") or ":" in path or "\\" in path
            or not isinstance(expected, str) or len(expected) != 64):
        raise ValueError("daily_composition_reference_invalid")
    raw = bucket.blob(path).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("daily_composition_source_checksum:" + path)
    return raw


def load_composition(bucket, *, price_capture, run_date):
    """No fallback when an explicitly registered composition is corrupt."""
    registry = json.loads(Path(__file__).with_name("daily_inference_sources.json").read_bytes())
    source = registry.get(price_capture["capture_id"])
    if source is None:
        return None
    raw = read_verified(bucket, source)
    value = json.loads(raw)
    if (value.get("schema_version") != SCHEMA or value.get("business_date") != run_date
            or value.get("price_capture_id") != price_capture["capture_id"]
            or value.get("price_manifest_sha256") != price_capture["capture_manifest_sha256"]
            or value.get("training_admitted") is not False):
        raise ValueError("daily_composition_identity_mismatch")
    from services.training_auxiliary_capture import FIELDS
    if set(value.get("auxiliary", {})) != set(FIELDS) or set(value.get("long", {})) != {"broker", "holding"}:
        raise ValueError("daily_composition_inventory_incomplete")
    for item in value.get("input_manifests", []):
        read_verified(bucket, item)
    if not value.get("input_manifests"):
        raise ValueError("daily_composition_lineage_missing")
    return {**value, "manifest_path": source["path"], "manifest_sha256": source["sha256"]}


def read_frame(bucket, item, *, run_date):
    if not item.get("inputs") or not item.get("availability"):
        raise ValueError("daily_composition_field_lineage_missing")
    # Verify original immutable inputs as well as the derived output.
    for source in item["inputs"]:
        read_verified(bucket, source)
    frame = pl.read_parquet(io.BytesIO(read_verified(bucket, item)))
    if frame.height != item.get("rows") or frame.columns != item.get("columns"):
        raise ValueError("daily_composition_shape_mismatch")
    if "date" not in frame.columns:
        raise ValueError("daily_composition_date_missing")
    frame = frame.with_columns(pl.col("date").cast(pl.String).str.slice(0, 10))
    keys = ["date", "symbol"] if "symbol" in frame.columns else ["date"]
    if (not frame.height or frame["date"].null_count()
            or frame.unique(keys).height != frame.height or frame["date"].max() > run_date):
        raise ValueError("daily_composition_dates_invalid")
    return frame


def append_wide_delta(baseline, delta, *, baseline_end, run_date):
    """Append later vendor observations; preserve all baseline cells exactly."""
    def normalize(frame):
        frame = frame.with_columns(pl.col("date").cast(pl.String).str.slice(0, 10))
        if frame["date"].null_count() or frame["date"].is_duplicated().any():
            raise ValueError("daily_composition_duplicate_or_null_date")
        return frame
    baseline, delta = normalize(baseline), normalize(delta)
    if baseline["date"].max() > baseline_end or baseline_end >= run_date:
        raise ValueError("daily_composition_baseline_window_invalid")
    delta = delta.filter(pl.col("date").is_between(pl.lit(baseline_end), pl.lit(run_date), closed="right"))
    return pl.concat([baseline, delta], how="diagonal_relaxed").sort("date")
