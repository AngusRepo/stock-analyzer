"""Build sequence-only prep artifacts from existing FinLab long-history output.

This module deliberately does not call the FinLab API. It hydrates already
materialized backfill artifacts into the `sequence_records_v3` contract consumed
by DLinear, PatchTST, iTransformer, and the TimesFM L2 sidecar.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from .model_store import _get_bucket
from .sequence_training import SEQUENCE_RETURN_SEMANTIC_VERSION


SCHEMA_VERSION = "finlab-long-history-sequence-prep-v2"
DEFAULT_OUTPUT_GCS_PREFIX = "universal/sequence_long"
DEFAULT_LANES = ("daily_price",)
LANE_MARKET_TYPE = {
    "daily_price": "TW_LISTED_OTC",
    "emerging_price_diversity": "TW_EMERGING",
}
LANE_PRICE_FIELDS = {
    "daily_price": ("adj_close", "adj_open"),
    "emerging_price_diversity": ("close", "open"),
}
TARGET_SEMANTIC_VERSION = SEQUENCE_RETURN_SEMANTIC_VERSION


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
    field: str,
) -> tuple[pl.DataFrame, str]:
    rel = f"raw/{lane}/{field}.parquet"
    if source_artifact_root:
        path = Path(source_artifact_root) / rel
        if not path.exists():
            raise SequenceSourceMissingError(f"missing source parquet: {path}")
        source_uri = str(path)
        return _validate_price_source(pl.read_parquet(path), source_uri), source_uri

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
    return _validate_price_source(pl.read_parquet(io.BytesIO(blob.download_as_bytes())), source_uri), source_uri


def _validate_price_source(frame: pl.DataFrame, source_uri: str) -> pl.DataFrame:
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


def _combine_wide_price_frames(frames: list[pl.DataFrame]) -> pl.DataFrame:
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


def _records_from_wide_prices(
    close_df: pl.DataFrame,
    open_df: pl.DataFrame,
    *,
    lane: str,
    market_type: str,
    min_len: int,
    start_date: str | None,
    end_date: str | None,
    source_uri: Any,
) -> list[dict[str, Any]]:
    close_df = _filter_dates(close_df, start_date=start_date, end_date=end_date)
    open_df = _filter_dates(open_df, start_date=start_date, end_date=end_date)
    if close_df.is_empty() or open_df.is_empty() or "date" not in close_df.columns or "date" not in open_df.columns:
        return []

    records: list[dict[str, Any]] = []
    for column in sorted((set(close_df.columns) & set(open_df.columns)) - {"date"}):
        symbol = _normalize_symbol(column)
        if not symbol:
            continue
        series = (
            close_df.select([
                pl.col("date").cast(pl.Utf8),
                pl.col(column).cast(pl.Float64, strict=False).alias("close"),
            ])
            .join(
                open_df.select([
                    pl.col("date").cast(pl.Utf8),
                    pl.col(column).cast(pl.Float64, strict=False).alias("open"),
                ]),
                on="date",
                how="inner",
            )
            .drop_nulls(["close", "open"])
            .filter(
                pl.col("close").is_finite()
                & (pl.col("close") > 0)
                & pl.col("open").is_finite()
                & (pl.col("open") > 0)
            )
            .sort("date")
        )
        if series.height < min_len:
            continue
        rows = series.to_dicts()
        dates = [str(row["date"])[:10] for row in rows]
        close = [float(row["close"]) for row in rows]
        open_prices = [float(row["open"]) for row in rows]
        records.append({
            "symbol": symbol,
            "market_type": market_type,
            "close": close,
            "open": open_prices,
            "dates": dates,
            "sequence_source": "finlab_long_history",
            "source_lane": lane,
            "source_uri": source_uri,
            "history_points": len(close),
            "date_min": dates[0],
            "date_max": dates[-1],
            "target_semantic_version": TARGET_SEMANTIC_VERSION,
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


def _manifest_checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    return hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _verified_existing_manifest(
    *,
    bucket: Any,
    output_gcs_prefix: str,
    records_checksum: str,
) -> dict[str, Any] | None:
    prefix = output_gcs_prefix.strip().rstrip("/")
    blob = bucket.blob(f"{prefix}/prep/sequence_manifest.json")
    if not blob.exists():
        return None
    manifest = json.loads(blob.download_as_text().lstrip("\ufeff"))
    if (
        manifest.get("status") != "ready"
        or manifest.get("contract") != "sequence_records_v3"
        or str(manifest.get("output_gcs_prefix") or "").rstrip("/") != prefix
        or manifest.get("records_checksum") != records_checksum
        or manifest.get("manifest_checksum") != _manifest_checksum(manifest)
    ):
        raise SequenceSourceInvalidError("immutable sequence output prefix collision")
    output_checksums = manifest.get("output_checksums") or {}
    if not isinstance(output_checksums, dict) or not output_checksums:
        raise SequenceSourceInvalidError("immutable sequence output inventory missing")
    for path, expected in output_checksums.items():
        artifact = bucket.blob(str(path))
        if not artifact.exists() or hashlib.sha256(artifact.download_as_bytes()).hexdigest() != expected:
            raise SequenceSourceInvalidError(f"immutable sequence checksum mismatch: {path}")
    return manifest


def _upload_sequence_batches(    *,
    bucket: Any,
    records: list[dict[str, Any]],
    output_gcs_prefix: str,
    batch_size: int,
    manifest: dict[str, Any],
) -> list[str]:
    paths: list[str] = []
    output_checksums: dict[str, str] = {}
    batch_rows: list[int] = []
    prefix = output_gcs_prefix.strip().rstrip("/")
    for batch_index, start in enumerate(range(0, len(records), batch_size)):
        batch = records[start:start + batch_size]
        buf = io.BytesIO()
        np.savez_compressed(
            buf,
            sequence_records=np.asarray(batch, dtype=object),
            series_close=np.asarray([row["close"] for row in batch], dtype=object),
            series_open=np.asarray([row["open"] for row in batch], dtype=object),
        )
        key = f"{prefix}/prep/batch_{batch_index}.npz"
        encoded = buf.getvalue()
        bucket.blob(key).upload_from_string(encoded, content_type="application/octet-stream")
        paths.append(key)
        output_checksums[key] = hashlib.sha256(encoded).hexdigest()
        batch_rows.append(len(batch))

    feature_names_path = f"{prefix}/prep/feature_names.json"
    feature_names = json.dumps(["close"], ensure_ascii=False).encode("utf-8")
    bucket.blob(feature_names_path).upload_from_string(
        feature_names,
        content_type="application/json",
    )
    output_checksums[feature_names_path] = hashlib.sha256(feature_names).hexdigest()
    manifest.update({
        "status": "ready",
        "batch_count": len(paths),
        "batch_rows": batch_rows,
        "output_checksums": output_checksums,
    })
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
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
        if lane not in LANE_PRICE_FIELDS:
            raise SequenceSourceInvalidError(f"unsupported sequence lane: {lane}")
        close_field, open_field = LANE_PRICE_FIELDS[lane]
        if len(source_gcs_prefixes) > 1 and not source_artifact_root:
            close_frames: list[pl.DataFrame] = []
            open_frames: list[pl.DataFrame] = []
            close_uris: list[str] = []
            open_uris: list[str] = []
            for prefix in source_gcs_prefixes:
                close_part, close_uri = _read_parquet_source(
                    lane=lane,
                    source_artifact_root=None,
                    source_gcs_prefix=prefix,
                    bucket=bucket,
                    field=close_field,
                )
                open_part, open_uri = _read_parquet_source(
                    lane=lane,
                    source_artifact_root=None,
                    source_gcs_prefix=prefix,
                    bucket=bucket,
                    field=open_field,
                )
                close_frames.append(close_part)
                open_frames.append(open_part)
                close_uris.append(close_uri)
                open_uris.append(open_uri)
            close_frame = _combine_wide_price_frames(close_frames)
            open_frame = _combine_wide_price_frames(open_frames)
            source_uri: Any = {"close": close_uris, "open": open_uris}
        else:
            prefix = source_gcs_prefix or (source_gcs_prefixes[0] if source_gcs_prefixes else None)
            close_frame, close_uri = _read_parquet_source(
                lane=lane,
                source_artifact_root=source_artifact_root,
                source_gcs_prefix=prefix,
                bucket=bucket,
                field=close_field,
            )
            open_frame, open_uri = _read_parquet_source(
                lane=lane,
                source_artifact_root=source_artifact_root,
                source_gcs_prefix=prefix,
                bucket=bucket,
                field=open_field,
            )
            source_uri = {"close": close_uri, "open": open_uri}
        records = _records_from_wide_prices(
            close_frame,
            open_frame,
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
            "source_rows": int(close_frame.height) if not close_frame.is_empty() else 0,
            "source_columns": int(len(close_frame.columns)) if not close_frame.is_empty() else 0,
            "sequence_records": int(len(records)),
            "close_field": close_field,
            "open_field": open_field,
        })
        all_records.extend(records)

    all_records.sort(key=lambda row: (str(row.get("market_type")), str(row.get("symbol"))))
    if max_series > 0:
        all_records = all_records[:max_series]

    summary = summarize_sequence_records(all_records)
    records_checksum = hashlib.sha256(
        json.dumps(all_records, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "created_at": _utc_now(),
        "contract": "sequence_records_v3",
        "target_semantic_version": TARGET_SEMANTIC_VERSION,
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
        "records_checksum": records_checksum,
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
        existing = _verified_existing_manifest(
            bucket=bucket,
            output_gcs_prefix=output_gcs_prefix,
            records_checksum=records_checksum,
        )
        if existing is not None:
            return {
                "status": "idempotent_ready",
                "dry_run": False,
                "output_gcs_prefix": output_gcs_prefix,
                "output_paths": sorted(
                    path for path in existing["output_checksums"] if path.endswith(".npz")
                ),
                "manifest_path": f"{output_gcs_prefix}/prep/sequence_manifest.json",
                "batch_count": int(existing.get("batch_count") or 0),
                "records": [],
                "record_preview": [],
                "manifest": existing,
            }
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
