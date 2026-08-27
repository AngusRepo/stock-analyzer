from __future__ import annotations

from dataclasses import dataclass
import os

from app.gcs_batch_io import (
    clear_gcs_batch_cache,
    download_existing_blobs,
    prune_gcs_batch_disk_cache,
)


@dataclass
class FakeObject:
    generation: int
    raw: bytes


class FakeBlob:
    def __init__(self, bucket: "FakeBucket", key: str) -> None:
        self.bucket = bucket
        self.key = key
        self.generation: int | None = None
        self.size: int | None = None

    def exists(self) -> bool:
        return self.key in self.bucket.objects

    def reload(self) -> None:
        obj = self.bucket.objects[self.key]
        self.generation = obj.generation
        self.size = len(obj.raw)

    def download_as_bytes(self, *, if_generation_match: int) -> bytes:
        obj = self.bucket.objects[self.key]
        assert if_generation_match == obj.generation
        return obj.raw


class FakeBucket:
    name = "retention-test-bucket"

    def __init__(self, objects: dict[str, FakeObject]) -> None:
        self.objects = objects

    def blob(self, key: str) -> FakeBlob:
        return FakeBlob(self, key)


def test_retention_prunes_only_expired_rebuildable_cache_entries(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STOCKVISION_GCS_BATCH_CACHE_DIR", str(tmp_path))
    bucket = FakeBucket(
        {
            "prep/batch_0.npz": FakeObject(1, b"old-generation"),
            "prep/batch_1.npz": FakeObject(1, b"current-generation"),
        }
    )
    clear_gcs_batch_cache()
    download_existing_blobs(bucket, ["prep/batch_0.npz"])
    old_files = set(tmp_path.rglob("*.*"))
    download_existing_blobs(bucket, ["prep/batch_1.npz"])
    new_files = set(tmp_path.rglob("*.*")) - old_files

    for path in old_files:
        os.utime(path, (700.0, 700.0))
    for path in new_files:
        os.utime(path, (950.0, 950.0))

    receipt = prune_gcs_batch_disk_cache(
        max_bytes=1024,
        max_age_seconds=100,
        now_epoch=1000.0,
    )
    assert receipt == {
        "entries": 1,
        "bytes": len(b"old-generation"),
        "remaining_bytes": len(b"current-generation"),
    }
    assert not any(path.exists() for path in old_files if path.suffix in {".blob", ".json"})
    assert all(path.exists() for path in new_files if path.suffix in {".blob", ".json"})
