"""Small GCS batch I/O helpers for Modal jobs.

The Google client does not expose a single multi-object download call, so the
practical "true batch" here is bounded parallel object download with stable
ordering and explicit missing-object handling.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any


def download_existing_blobs(
    bucket: Any,
    keys: list[str],
    *,
    max_workers: int = 4,
) -> list[tuple[str, bytes | None]]:
    """Download GCS objects concurrently and return `(key, bytes | None)`.

    `None` means the object is missing. Other errors are raised because training
    should fail loudly instead of silently using partial data.
    """
    if not keys:
        return []

    workers = max(1, min(int(max_workers or 4), len(keys), 8))

    def load_one(key: str) -> tuple[str, bytes | None]:
        blob = bucket.blob(key)
        if not blob.exists():
            return key, None
        return key, blob.download_as_bytes()

    ordered: dict[str, bytes | None] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(load_one, key): key for key in keys}
        for future in as_completed(futures):
            key, data = future.result()
            ordered[key] = data

    return [(key, ordered.get(key)) for key in keys]
