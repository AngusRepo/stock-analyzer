"""Build sequence-only prep artifacts from existing FinLab long-history output.

This module deliberately does not call the FinLab API. It hydrates already
materialized backfill artifacts into the `sequence_records_v2` contract consumed
by DLinear, PatchTST, iTransformer, and the TimesFM L2 sidecar.
"""

from __future__ import annotations

import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from .model_store import _get_bucket


SCHEMA_VERSION = "finlab-long-history-sequence-prep-v1"
DEFAULT_OUTPUT_GCS_PREFIX = "universal/sequence_long"
DEFAULT_LANES = ("daily_price", "emerging_price_diversity")
LANE_MARKET_TYPE = {
    "daily_price": "TW_LISTED_OTC",
    "emerging_price_diversity": "TW_EMERGING",
}


class SequenceSourceMissingError(RuntimeError):
    """Raised when a requested long-history source artifact is absent."""


class SequenceSourceInvalidError(RuntimeError):
    """Raised when a source artifact exists but cannot satisfy the sequence contract."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_symbol(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text.split()[0].strip() or text


def _parse_lanes(value: Any) -> list[str]:
    if value is None:
        return list(DEFAULT_LANES)
    if isinstance(value, str):
        lanes = [item.strip() for item in value.split(",") if item.strip()]
    else:
        lanes = [str(item).strip() for item in value if str(item).strip()]
    return lanes or list(DEFAULT_LANES)


def _read_parquet_source(
    *,
    lane: str,
    source_artifact_root: str | None,
    source_gcs_prefix: str | None,
    bucket: Any | None,
) -> tuple[pl.DataFrame, str]:
    rel = f"raw/{lane}/close.parquet"
    if source_artifact_root:
        path = Path(source_artifact_root) / rel
        if not path.exists():
            raise SequenceSourceMissingError(f"missing source parquet: {path}")
        source_uri = str(path)
        return _validate_close_source(pl.read_parquet(path), source_uri), source_uri

    if not source_gcs_prefix:
        raise ValueError("source_artifact_root or source_gcs_prefix is required")
    bucket_name, object_prefix = _split_gcs_prefix(source_gcs_prefix)
    if bucket is None:
        bucket = _readonly_bucket(bucket_name)

    key = f"{object_prefix.strip().rstrip('/')}/{rel}"
    blob = bucket.blob(key)
    if not blob.exists():
        raise SequenceSourceMissingError(f"missing source parquet: gs://{bucket_name or '*'}/{key}")
    source_uri = f"gs://{bucket_name or '*'}/{key}"
    return _validate_close_source(pl.read_parquet(io.BytesIO(blob.download_as_bytes())), source_uri), source_uri


def _validate_close_source(frame: pl.DataFrame, source_uri: str) -> pl.DataFrame:
    if frame.is_empty():
        raise SequenceSourceInvalidError(f"empty source parquet: {source_uri}")
    if "date" not in frame.columns:
        raise SequenceSourceInvalidError(f"source parquet missing date column: {source_uri}")
    value_columns = [column for column in frame.columns if column != "date"]
    if not value_columns:
        raise SequenceSourceInvalidError(f"source parquet has no symbol columns: {source_uri}")
    return frame


def _parse_source_gcs_prefixes(payload: dict[str, Any]) -> list[str]:
    value = payload.get("source_gcs_prefixes")
    if value is None:
        single = str(payload.get("source_gcs_prefix") or "").strip()
        return [single] if single else []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return [str(item).strip() for item in value if str(item).strip()]


def _combine_wide_close_frames(frames: list[pl.DataFrame]) -> pl.DataFrame:
    valid = [frame for frame in frames if not frame.is_empty() and "date" in frame.columns]
    if not valid:
        raise SequenceSourceInvalidError("no valid source frames to combine")

    normalized: list[pl.DataFrame] = []
    for frame in valid:
        normalized.append(frame.with_columns(
            [pl.col("date").cast(pl.Utf8).str.slice(0, 10).alias("date")]
            + [
                pl.col(column).cast(pl.Float64, strict=False).alias(column)
                for column in frame.columns
                if column != "date"
            ]
        ))
    combined = pl.concat(normalized, how="diagonal_relaxed").sort("date")
    value_columns = [column for column in combined.columns if column != "date"]
    return combined.group_by("date", maintain_order=True).agg([
        pl.col(column).drop_nulls().last().alias(column)
        for column in value_columns
    ]).sort("date")


def _split_gcs_prefix(value: str) -> tuple[str | None, str]:
    text = str(value or "").strip().rstrip("/")
    if not text.startswith("gs://"):
        return None, text
    rest = text[5:]
    if "/" not in rest:
        return rest, ""
    bucket_name, prefix = rest.split("/", 1)
    return bucket_name, prefix.strip("/")


def _readonly_bucket(bucket_name: str | None = None):
    name = (bucket_name or os.environ.get("GCS_BUCKET_NAME") or "").strip()
    if not name:
        raise RuntimeError("GCS_BUCKET_NAME not configured")
    from google.cloud import storage

    return storage.Client().bucket(name)


def _filter_dates(df: pl.DataFrame, *, start_date: str | None, end_date: str | None) -> pl.DataFrame:
    if df.is_empty() or "date" not in df.columns:
        return df
    out = df.with_columns(pl.col("date").cast(pl.Utf8).str.slice(0, 10).alias("date"))
    if start_date:
        out = out.filter(pl.col("date") >= str(start_date))
    if end_date:
        out = out.filter(pl.col("date") <= str(end_date))
    return out.sort("date")


def _records_from_wide_close(
    df: pl.DataFrame,
    *,
    lane: str,
    market_type: str,
    min_len: int,
    start_date: str | None,
    end_date: str | None,
    source_uri: Any,
) -> list[dict[str, Any]]:
    df = _filter_dates(df, start_date=start_date, end_date=end_date)
    if df.is_empty() or "date" not in df.columns:
        return []

    records: list[dict[str, Any]] = []
    for column in [name for name in df.columns if name != "date"]:
        symbol = _normalize_symbol(column)
        if not symbol:
            continue
        series = (
            df.select([
                pl.col("date").cast(pl.Utf8),
                pl.col(column).cast(pl.Float64, strict=False).alias("close"),
            ])
            .drop_nulls()
            .filter(pl.col("close").is_finite() & (pl.col("close") > 0))
        )
        if series.height < min_len:
            continue
        rows = series.to_dicts()
        dates = [str(row["date"])[:10] for row in rows]
        close = [float(row["close"]) for row in rows]
        records.append({
            "symbol": symbol,
            "market_type": market_type,
            "close": close,
            "dates": dates,
            "sequence_source": "finlab_long_history",
            "source_lane": lane,
            "source_uri": source_uri,
            "history_points": len(close),
            "date_min": dates[0],
            "date_max": dates[-1],
        })
    return records


def summarize_sequence_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    lengths = [len(row.get("close") or []) for row in records]
    dates = [
        str(value)[:10]
        for row in records
        for value in (row.get("dates") or [])
        if str(value)
    ]
    return {
        "symbols": len(records),
        "rows": int(sum(lengths)),
        "min_series_len": int(min(lengths)) if lengths else 0,
        "max_series_len": int(max(lengths)) if lengths else 0,
        "date_min": min(dates) if dates else None,
        "date_max": max(dates) if dates else None,
        "markets": sorted({str(row.get("market_type") or "unknown") for row in records}),
    }


def _upload_sequence_batches(
    *,
    bucket: Any,
    records: list[dict[str, Any]],
    output_gcs_prefix: str,
    batch_size: int,
    manifest: dict[str, Any],
) -> list[str]:
    paths: list[str] = []
    prefix = output_gcs_prefix.strip().rstrip("/")
    for batch_index, start in enumerate(range(0, len(records), batch_size)):
        batch = records[start:start + batch_size]
        buf = io.BytesIO()
        np.savez_compressed(
            buf,
            sequence_records=np.asarray(batch, dtype=object),
            series_close=np.asarray([row["close"] for row in batch], dtype=object),
        )
        key = f"{prefix}/prep/batch_{batch_index}.npz"
        bucket.blob(key).upload_from_string(buf.getvalue(), content_type="application/octet-stream")
        paths.append(key)

    bucket.blob(f"{prefix}/prep/feature_names.json").upload_from_string(
        json.dumps(["close"], ensure_ascii=False),
        content_type="application/json",
    )
    bucket.blob(f"{prefix}/prep/sequence_manifest.json").upload_from_string(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return paths


def build_finlab_long_history_sequence_prep(payload: dict[str, Any], *, bucket: Any | None = None) -> dict[str, Any]:
    """Hydrate existing FinLab backfill parquet into sequence-only prep batches."""

    source_artifact_root = str(payload.get("source_artifact_root") or "").strip() or None
    source_gcs_prefix = str(payload.get("source_gcs_prefix") or "").strip() or None
    source_gcs_prefixes = _parse_source_gcs_prefixes(payload)
    output_gcs_prefix = str(payload.get("output_gcs_prefix") or DEFAULT_OUTPUT_GCS_PREFIX).strip().rstrip("/")
    lanes = _parse_lanes(payload.get("lanes"))
    min_len = max(1, int(payload.get("min_len") or 65))
    batch_size = max(1, int(payload.get("batch_size") or 512))
    max_series = int(payload.get("max_series") or 0)
    start_date = str(payload.get("start_date") or "").strip() or None
    end_date = str(payload.get("end_date") or "").strip() or None
    dry_run = bool(payload.get("dry_run", False))

    all_records: list[dict[str, Any]] = []
    lane_reports: list[dict[str, Any]] = []
    for lane in lanes:
        if len(source_gcs_prefixes) > 1 and not source_artifact_root:
            frames: list[pl.DataFrame] = []
            source_uris: list[str] = []
            for prefix in source_gcs_prefixes:
                frame_part, source_uri_part = _read_parquet_source(
                    lane=lane,
                    source_artifact_root=None,
                    source_gcs_prefix=prefix,
                    bucket=bucket,
                )
                frames.append(frame_part)
                source_uris.append(source_uri_part)
            frame = _combine_wide_close_frames(frames)
            source_uri: Any = source_uris
        else:
            frame, source_uri = _read_parquet_source(
                lane=lane,
                source_artifact_root=source_artifact_root,
                source_gcs_prefix=source_gcs_prefix or (source_gcs_prefixes[0] if source_gcs_prefixes else None),
                bucket=bucket,
            )
        records = _records_from_wide_close(
            frame,
            lane=lane,
            market_type=LANE_MARKET_TYPE.get(lane, lane),
            min_len=min_len,
            start_date=start_date,
            end_date=end_date,
            source_uri=source_uri,
        )
        lane_reports.append({
            "lane": lane,
            "source_uri": source_uri,
            "source_rows": int(frame.height) if not frame.is_empty() else 0,
            "source_columns": int(len(frame.columns)) if not frame.is_empty() else 0,
            "sequence_records": int(len(records)),
        })
        all_records.extend(records)

    all_records.sort(key=lambda row: (str(row.get("market_type")), str(row.get("symbol"))))
    if max_series > 0:
        all_records = all_records[:max_series]

    summary = summarize_sequence_records(all_records)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "created_at": _utc_now(),
        "contract": "sequence_records_v2",
        "source": {
            "type": "finlab_existing_backfill_artifact",
            "source_artifact_root": source_artifact_root,
            "source_gcs_prefix": source_gcs_prefix,
            "source_gcs_prefixes": source_gcs_prefixes or None,
            "lanes": lanes,
            "no_finlab_api_call": True,
        },
        "filters": {
            "start_date": start_date,
            "end_date": end_date,
            "min_len": min_len,
            "max_series": max_series or None,
        },
        "output_gcs_prefix": output_gcs_prefix,
        "batch_size": batch_size,
        "summary": summary,
        "lane_reports": lane_reports,
    }

    if not all_records:
        return {
            "status": "blocked",
            "blockers": ["no_valid_finlab_long_history_sequence_records"],
            "manifest": manifest,
        }

    output_paths: list[str] = []
    if not dry_run:
        if bucket is None:
            bucket = _get_bucket()
        if bucket is None:
            raise RuntimeError("GCS bucket not available")
        output_paths = _upload_sequence_batches(
            bucket=bucket,
            records=all_records,
            output_gcs_prefix=output_gcs_prefix,
            batch_size=batch_size,
            manifest=manifest,
        )

    return {
        "status": "ok",
        "dry_run": dry_run,
        "output_gcs_prefix": output_gcs_prefix,
        "output_paths": output_paths,
        "manifest_path": f"{output_gcs_prefix}/prep/sequence_manifest.json",
        "batch_count": int((len(all_records) + batch_size - 1) // batch_size),
        "records": all_records if bool(payload.get("return_records")) else [],
        "record_preview": [
            {
                "symbol": row.get("symbol"),
                "market_type": row.get("market_type"),
                "history_points": row.get("history_points"),
                "date_min": row.get("date_min"),
                "date_max": row.get("date_max"),
                "source_lane": row.get("source_lane"),
            }
            for row in all_records[:5]
        ],
        "manifest": manifest,
    }
