"""Small GCS batch I/O helpers for Modal jobs.

The Google client does not expose a single multi-object download call, so the
practical "true batch" here is bounded parallel object download with stable
ordering and explicit missing-object handling.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from typing import Any

_BLOB_BYTES_CACHE: dict[str, bytes] = {}
_BLOB_CACHE_STATS = {
    "hits": 0,
    "memory_hits": 0,
    "disk_hits": 0,
    "misses": 0,
    "gcs_downloads": 0,
    "gcs_download_bytes": 0,
    "disk_cache_bytes_avoided": 0,
    "disk_cache_integrity_failures": 0,
    "disk_cache_write_failures": 0,
    "metadata_checks": 0,
    "disk_cache_pruned_entries": 0,
    "disk_cache_pruned_bytes": 0,
}
_STATS_LOCK = threading.Lock()


def _add_stat(key: str, value: int = 1) -> None:
    with _STATS_LOCK:
        _BLOB_CACHE_STATS[key] += int(value)


def _cache_root() -> Path | None:
    configured = os.environ.get("STOCKVISION_GCS_BATCH_CACHE_DIR", "").strip()
    return Path(configured) if configured else None


def _blob_identity(bucket: Any, key: str, generation: str) -> dict[str, str]:
    return {
        "schema_version": "stockvision-gcs-generation-cache-v1",
        "bucket": str(getattr(bucket, "name", "") or "unknown"),
        "key": key,
        "generation": generation,
    }


def _cache_paths(identity: dict[str, str]) -> tuple[Path, Path]:
    root = _cache_root()
    if root is None:
        raise RuntimeError("gcs_batch_disk_cache_disabled")
    digest = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return root / digest[:2] / f"{digest}.blob", root / digest[:2] / f"{digest}.json"


def _read_disk_cache(identity: dict[str, str], expected_size: int) -> bytes | None:
    if _cache_root() is None:
        return None
    try:
        blob_path, metadata_path = _cache_paths(identity)
        if not blob_path.is_file() or not metadata_path.is_file():
            return None
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("identity") != identity or int(metadata.get("size") or -1) != expected_size:
            _add_stat("disk_cache_integrity_failures")
            return None
        raw = blob_path.read_bytes()
        if len(raw) != expected_size or hashlib.sha256(raw).hexdigest() != metadata.get("sha256"):
            _add_stat("disk_cache_integrity_failures")
            return None
        _add_stat("hits")
        _add_stat("disk_hits")
        _add_stat("disk_cache_bytes_avoided", len(raw))
        return raw
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        _add_stat("disk_cache_integrity_failures")
        return None


def _write_disk_cache(identity: dict[str, str], raw: bytes) -> None:
    if _cache_root() is None:
        return
    try:
        blob_path, metadata_path = _cache_paths(identity)
        blob_path.parent.mkdir(parents=True, exist_ok=True)
        suffix = f".{os.getpid()}.{threading.get_ident()}.tmp"
        blob_tmp = blob_path.with_name(blob_path.name + suffix)
        metadata_tmp = metadata_path.with_name(metadata_path.name + suffix)
        blob_tmp.write_bytes(raw)
        metadata_tmp.write_text(
            json.dumps(
                {
                    "identity": identity,
                    "size": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        os.replace(blob_tmp, blob_path)
        os.replace(metadata_tmp, metadata_path)
    except OSError:
        _add_stat("disk_cache_write_failures")


def prune_gcs_batch_disk_cache(
    *,
    max_bytes: int = 4 * 1024 * 1024 * 1024,
    max_age_seconds: int = 35 * 24 * 60 * 60,
    now_epoch: float | None = None,
) -> dict[str, int]:
    """Prune only rebuildable generation-cache files under the configured root."""
    root = _cache_root()
    if root is None or not root.is_dir():
        return {"entries": 0, "bytes": 0, "remaining_bytes": 0}
    now = float(now_epoch if now_epoch is not None else time.time())
    entries: list[tuple[Path, int, float]] = []
    for blob_path in root.rglob("*.blob"):
        try:
            stat = blob_path.stat()
            entries.append((blob_path, int(stat.st_size), float(stat.st_mtime)))
        except OSError:
            continue
    remaining = sum(size for _, size, _ in entries)
    pruned_entries = 0
    pruned_bytes = 0
    for blob_path, size, modified in sorted(entries, key=lambda row: row[2]):
        expired = now - modified > max(0, int(max_age_seconds))
        over_capacity = remaining > max(0, int(max_bytes))
        if not expired and not over_capacity:
            continue
        metadata_path = blob_path.with_suffix(".json")
        try:
            blob_path.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)
        except OSError:
            continue
        remaining = max(0, remaining - size)
        pruned_entries += 1
        pruned_bytes += size
    _add_stat("disk_cache_pruned_entries", pruned_entries)
    _add_stat("disk_cache_pruned_bytes", pruned_bytes)
    return {"entries": pruned_entries, "bytes": pruned_bytes, "remaining_bytes": remaining}


def diff_gcs_batch_cache_stats(before: dict[str, int], after: dict[str, int]) -> dict[str, int]:
    return {key: int(after.get(key, 0)) - int(before.get(key, 0)) for key in _BLOB_CACHE_STATS}


def clear_gcs_batch_cache() -> None:
    _BLOB_BYTES_CACHE.clear()
    for key in _BLOB_CACHE_STATS:
        _BLOB_CACHE_STATS[key] = 0


def get_gcs_batch_cache_stats() -> dict[str, int]:
    return dict(_BLOB_CACHE_STATS)


def download_existing_blobs(
    bucket: Any,
    keys: list[str],
    *,
    max_workers: int = 4,
    use_cache: bool = True,
) -> list[tuple[str, bytes | None]]:
    """Download GCS objects concurrently and return `(key, bytes | None)`.

    `None` means the object is missing. Other errors are raised because training
    should fail loudly instead of silently using partial data.
    """
    if not keys:
        return []

    unique_keys = list(dict.fromkeys(keys))
    workers = max(1, min(int(max_workers or 4), len(unique_keys) or 1, 8))

    def load_one(key: str) -> tuple[str, bytes | None]:
        blob = bucket.blob(key)
        if not blob.exists():
            return key, None
        blob.reload()
        _add_stat("metadata_checks")
        generation = str(getattr(blob, "generation", "") or "")
        if not generation:
            raise RuntimeError(f"gcs_blob_generation_missing:{key}")
        expected_size = int(getattr(blob, "size", 0) or 0)
        identity = _blob_identity(bucket, key, generation)
        cache_key = json.dumps(identity, sort_keys=True, separators=(",", ":"))
        if use_cache and cache_key in _BLOB_BYTES_CACHE:
            raw = _BLOB_BYTES_CACHE[cache_key]
            if len(raw) == expected_size:
                _add_stat("hits")
                _add_stat("memory_hits")
                return key, raw
        if use_cache:
            raw = _read_disk_cache(identity, expected_size)
            if raw is not None:
                _BLOB_BYTES_CACHE[cache_key] = raw
                return key, raw
        _add_stat("misses")
        raw = blob.download_as_bytes(if_generation_match=int(generation))
        if len(raw) != expected_size:
            raise RuntimeError(f"gcs_blob_size_mismatch:{key}:{len(raw)}:{expected_size}")
        _add_stat("gcs_downloads")
        _add_stat("gcs_download_bytes", len(raw))
        if use_cache:
            _BLOB_BYTES_CACHE[cache_key] = raw
            _write_disk_cache(identity, raw)
        return key, raw

    loaded: dict[str, bytes | None] = {}
    if unique_keys:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(load_one, key): key for key in unique_keys}
            for future in as_completed(futures):
                key, data = future.result()
                loaded[key] = data
    return [(key, loaded.get(key)) for key in keys]
