from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any, Callable
from contextlib import contextmanager

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


@contextmanager
def snapshot_local_path(uri: str):
    """Own only downloaded scratch files; local/file:// sources are borrowed."""
    if not uri.startswith("gs://"):
        yield Path(uri[7:] if uri.startswith("file://") else uri)
        return
    try:
        from google.cloud import storage
    except ImportError as exc:
        raise RuntimeError("google_cloud_storage_not_available_for_snapshot_read") from exc
    bucket_name, blob_name = uri[5:].split("/", 1)
    if not bucket_name or not blob_name:
        raise ValueError("snapshot_gcs_uri_invalid")
    with tempfile.TemporaryDirectory(prefix="stockvision-snapshot-") as directory:
        target = Path(directory) / "component.parquet"
        storage.Client().bucket(bucket_name).blob(blob_name).download_to_filename(str(target))
        yield target


def read_snapshot_parquet(uri: str, *, transform: Callable[[pl.LazyFrame], pl.LazyFrame] | None = None) -> pl.DataFrame:
    with snapshot_local_path(uri) as path:
        if not path.exists():
            raise RuntimeError(f"snapshot_component_not_found:{uri}")
        lazy = pl.scan_parquet(str(path))
        return (transform(lazy) if transform is not None else lazy).collect()


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
