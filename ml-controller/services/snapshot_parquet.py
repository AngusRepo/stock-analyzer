from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

import polars as pl


def snapshot_metadata(manifest: dict[str, Any]) -> dict[str, Any]:
    raw = manifest.get("metadata_json")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    return {}


def snapshot_component_uri(
    manifest: dict[str, Any],
    name: str,
    *,
    required: bool = True,
) -> str | None:
    metadata = snapshot_metadata(manifest)
    components = metadata.get("components")
    if isinstance(components, dict) and components.get(name):
        return str(components[name])

    base_uri = str(manifest.get("gcs_uri") or "").rstrip("/")
    if base_uri:
        return f"{base_uri}/{name}.parquet"

    if required:
        raise RuntimeError(f"snapshot_component_missing:{name}")
    return None


def _download_gcs_uri(uri: str) -> Path:
    try:
        from google.cloud import storage
    except Exception as exc:
        raise RuntimeError("google_cloud_storage_not_available_for_snapshot_read") from exc

    bucket_name, blob_name = uri[5:].split("/", 1)
    target = Path(tempfile.mkdtemp(prefix="stockvision-snapshot-")) / Path(blob_name).name
    storage.Client().bucket(bucket_name).blob(blob_name).download_to_filename(str(target))
    return target


def read_snapshot_parquet(uri: str) -> pl.DataFrame:
    if uri.startswith("file://"):
        path = Path(uri[7:])
    elif uri.startswith("gs://"):
        path = _download_gcs_uri(uri)
    else:
        path = Path(uri)

    if not path.exists():
        raise RuntimeError(f"snapshot_component_not_found:{uri}")
    return pl.scan_parquet(str(path)).collect()


def read_snapshot_component(
    manifest: dict[str, Any],
    name: str,
    *,
    required: bool = True,
) -> pl.DataFrame | None:
    uri = snapshot_component_uri(manifest, name, required=required)
    if not uri:
        return None
    return read_snapshot_parquet(uri)
