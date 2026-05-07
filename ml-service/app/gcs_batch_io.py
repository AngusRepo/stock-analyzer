"""Small GCS batch I/O helpers for Modal jobs.

The Google client does not expose a single multi-object download call, so the
practical "true batch" here is bounded parallel object download with stable
ordering and explicit missing-object handling.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

_BLOB_BYTES_CACHE: dict[str, bytes | None] = {}
_BLOB_CACHE_STATS = {
    "hits": 0,
    "misses": 0,
    "gcs_downloads": 0,
}


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
    cached: dict[str, bytes | None] = {}
    missing_keys: list[str] = []
    for key in unique_keys:
        if use_cache and key in _BLOB_BYTES_CACHE:
            _BLOB_CACHE_STATS["hits"] += 1
            cached[key] = _BLOB_BYTES_CACHE[key]
        else:
            _BLOB_CACHE_STATS["misses"] += 1
            missing_keys.append(key)

    workers = max(1, min(int(max_workers or 4), len(missing_keys) or 1, 8))

    def load_one(key: str) -> tuple[str, bytes | None]:
        blob = bucket.blob(key)
        if not blob.exists():
            return key, None
        _BLOB_CACHE_STATS["gcs_downloads"] += 1
        return key, blob.download_as_bytes()

    loaded: dict[str, bytes | None] = {}
    if missing_keys:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(load_one, key): key for key in missing_keys}
            for future in as_completed(futures):
                key, data = future.result()
                loaded[key] = data
                if use_cache:
                    _BLOB_BYTES_CACHE[key] = data

    ordered = {**cached, **loaded}
    return [(key, ordered.get(key)) for key in keys]
