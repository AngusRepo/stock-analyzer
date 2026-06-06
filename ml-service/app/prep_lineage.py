"""Prep lineage and freshness guards for production artifact registration."""

from __future__ import annotations

import os
from datetime import date, datetime, timezone
from typing import Any, Iterable

import numpy as np

from .artifact_contract import stable_sha256


PREP_LINEAGE_SCHEMA_VERSION = "prep-lineage-v1"
DEFAULT_MAX_STALE_DAYS = 3


def _utc_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return str(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _date_bounds(values: Iterable[Any] | None) -> tuple[str | None, str | None]:
    if values is None:
        return None, None
    dates = sorted(str(value)[:10] for value in np.asarray(list(values)).reshape(-1).tolist() if str(value))
    if not dates:
        return None, None
    return dates[0], dates[-1]


def _parse_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except ValueError:
        return None


def _parse_datetime_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _blob_updated(blob: Any) -> str | None:
    return _utc_iso(getattr(blob, "updated", None) or getattr(blob, "time_created", None))


def _blob_size(blob: Any) -> int | None:
    value = getattr(blob, "size", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _listed_blobs(bucket: Any, *, prefix: str) -> dict[str, Any]:
    try:
        return {
            str(blob.name): blob
            for blob in bucket.list_blobs(prefix=prefix)
            if getattr(blob, "name", None)
        }
    except Exception:
        return {}


def collect_prep_lineage(
    bucket: Any,
    *,
    gcs_prefix: str,
    batch_count: int,
    feature_names: Iterable[Any] | None = None,
    rows: int | None = None,
    dates: Iterable[Any] | None = None,
) -> dict[str, Any]:
    """Collect enough GCS prep lineage to audit formal artifact freshness."""

    clean_prefix = str(gcs_prefix or "universal").strip().rstrip("/")
    prep_prefix = f"{clean_prefix}/prep"
    listed = _listed_blobs(bucket, prefix=f"{prep_prefix}/")
    batch_objects: list[dict[str, Any]] = []
    latest_timestamp: str | None = None
    prep_bytes = 0

    for idx in range(max(1, int(batch_count or 1))):
        key = f"{prep_prefix}/batch_{idx}.npz"
        try:
            blob = listed.get(key) or bucket.blob(key)
        except Exception:
            continue
        try:
            exists = bool(blob.exists())
        except Exception:
            exists = False
        if not exists:
            continue
        updated = _blob_updated(blob)
        size = _blob_size(blob)
        if size is not None:
            prep_bytes += size
        if updated and (latest_timestamp is None or updated > latest_timestamp):
            latest_timestamp = updated
        batch_objects.append({
            "path": key,
            "updated": updated,
            "size": size,
        })

    feature_path = f"{prep_prefix}/feature_names.json"
    feature_blob = listed.get(feature_path) or bucket.blob(feature_path)
    feature_names_list = [str(value) for value in (feature_names or [])]
    try:
        if not feature_names_list and feature_blob.exists():
            import json

            feature_names_list = [str(value) for value in json.loads(feature_blob.download_as_text())]
    except Exception:
        feature_names_list = []
    feature_updated = _blob_updated(feature_blob)
    if feature_updated and (latest_timestamp is None or feature_updated > latest_timestamp):
        latest_timestamp = feature_updated

    date_min, date_max = _date_bounds(dates)
    return {
        "schema_version": PREP_LINEAGE_SCHEMA_VERSION,
        "gcs_prefix": clean_prefix,
        "prep_prefix": prep_prefix,
        "prep_timestamp": latest_timestamp,
        "date_min": date_min,
        "date_max": date_max,
        "rows": int(rows) if rows is not None else None,
        "feature_count": len(feature_names_list),
        "feature_hash": stable_sha256(feature_names_list),
        "feature_names_path": feature_path,
        "feature_names_updated": feature_updated,
        "batch_count_requested": int(batch_count or 0),
        "prep_objects": len(batch_objects),
        "prep_bytes": int(prep_bytes),
        "batch_objects": batch_objects,
    }


def max_stale_days_from_env(default: int = DEFAULT_MAX_STALE_DAYS) -> int:
    raw = os.environ.get("UNIVERSAL_PREP_MAX_STALE_DAYS")
    if raw in (None, ""):
        return int(default)
    try:
        return max(0, int(raw))
    except ValueError:
        return int(default)


def validate_prep_lineage_for_registration(
    lineage: dict[str, Any],
    *,
    as_of_date: str | None = None,
    max_stale_days: int | None = None,
    require_timestamp: bool = True,
) -> dict[str, Any]:
    """Fail closed before production registration if prep lineage is stale."""

    max_days = max_stale_days_from_env() if max_stale_days is None else max(0, int(max_stale_days))
    as_of = _parse_date(as_of_date) or datetime.now(timezone.utc).date()
    errors: list[str] = []

    date_max = _parse_date(lineage.get("date_max"))
    if date_max is None:
        errors.append("prep_date_max_missing")
    elif (as_of - date_max).days > max_days:
        errors.append(f"prep_date_max_stale:{lineage.get('date_max')}")

    prep_timestamp = _parse_datetime_date(lineage.get("prep_timestamp"))
    if prep_timestamp is None:
        if require_timestamp:
            errors.append("prep_timestamp_missing")
    elif (as_of - prep_timestamp).days > max_days:
        errors.append(f"prep_timestamp_stale:{lineage.get('prep_timestamp')}")

    if int(lineage.get("rows") or 0) <= 0:
        errors.append("prep_rows_missing")
    if int(lineage.get("feature_count") or 0) <= 0:
        errors.append("prep_feature_count_missing")
    if int(lineage.get("prep_objects") or 0) <= 0:
        errors.append("prep_objects_missing")

    report = {
        "status": "ok" if not errors else "error",
        "as_of_date": as_of.isoformat(),
        "max_stale_days": max_days,
        "errors": errors,
    }
    if errors:
        raise RuntimeError(f"stale prep lineage blocks artifact registration: {errors}")
    return report


def attach_prep_lineage_aliases(metadata: dict[str, Any], lineage: dict[str, Any]) -> dict[str, Any]:
    """Attach both nested and top-level lineage fields for easy GCS audits."""

    updated = dict(metadata)
    updated["prep_lineage"] = dict(lineage)
    for key in ("prep_timestamp", "date_min", "date_max", "rows", "feature_count", "feature_hash", "gcs_prefix"):
        if key == "gcs_prefix":
            updated[key] = lineage.get("gcs_prefix")
        elif key in {"feature_count"} and updated.get(key) not in (None, 0):
            continue
        else:
            updated[key] = lineage.get(key)
    return updated
