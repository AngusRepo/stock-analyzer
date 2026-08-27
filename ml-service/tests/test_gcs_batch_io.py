from __future__ import annotations

from dataclasses import dataclass

from app.gcs_batch_io import (
    clear_gcs_batch_cache,
    download_existing_blobs,
    get_gcs_batch_cache_stats,
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
        self.bucket.downloads += 1
        return obj.raw


class FakeBucket:
    name = "immutable-test-bucket"

    def __init__(self, objects: dict[str, FakeObject]) -> None:
        self.objects = objects
        self.downloads = 0

    def blob(self, key: str) -> FakeBlob:
        return FakeBlob(self, key)


def test_generation_bound_disk_cache_avoids_cross_container_download(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STOCKVISION_GCS_BATCH_CACHE_DIR", str(tmp_path))
    bucket = FakeBucket({"prep/batch_0.npz": FakeObject(7, b"immutable-seven")})
    clear_gcs_batch_cache()

    assert download_existing_blobs(bucket, ["prep/batch_0.npz"]) == [
        ("prep/batch_0.npz", b"immutable-seven")
    ]
    assert bucket.downloads == 1

    # A new Modal container has an empty process cache but sees the committed Volume.
    clear_gcs_batch_cache()
    assert download_existing_blobs(bucket, ["prep/batch_0.npz"]) == [
        ("prep/batch_0.npz", b"immutable-seven")
    ]
    stats = get_gcs_batch_cache_stats()
    assert bucket.downloads == 1
    assert stats["disk_hits"] == 1
    assert stats["disk_cache_bytes_avoided"] == len(b"immutable-seven")
    assert stats["gcs_download_bytes"] == 0


def test_generation_change_never_reuses_stale_cache(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STOCKVISION_GCS_BATCH_CACHE_DIR", str(tmp_path))
    bucket = FakeBucket({"prep/batch_0.npz": FakeObject(1, b"old")})
    clear_gcs_batch_cache()
    download_existing_blobs(bucket, ["prep/batch_0.npz"])

    bucket.objects["prep/batch_0.npz"] = FakeObject(2, b"new-generation")
    clear_gcs_batch_cache()
    assert download_existing_blobs(bucket, ["prep/batch_0.npz"])[0][1] == b"new-generation"
    assert bucket.downloads == 2
    assert get_gcs_batch_cache_stats()["gcs_download_bytes"] == len(b"new-generation")


def test_tampered_disk_cache_is_rejected_and_rehydrated(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STOCKVISION_GCS_BATCH_CACHE_DIR", str(tmp_path))
    bucket = FakeBucket({"prep/batch_0.npz": FakeObject(3, b"clean")})
    clear_gcs_batch_cache()
    download_existing_blobs(bucket, ["prep/batch_0.npz"])

    cache_blob = next(tmp_path.rglob("*.blob"))
    cache_blob.write_bytes(b"dirty")
    clear_gcs_batch_cache()
    assert download_existing_blobs(bucket, ["prep/batch_0.npz"])[0][1] == b"clean"
    stats = get_gcs_batch_cache_stats()
    assert bucket.downloads == 2
    assert stats["disk_cache_integrity_failures"] == 1
    assert stats["gcs_downloads"] == 1


def test_missing_object_remains_explicit_none(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STOCKVISION_GCS_BATCH_CACHE_DIR", str(tmp_path))
    bucket = FakeBucket({})
    clear_gcs_batch_cache()
    assert download_existing_blobs(bucket, ["prep/missing.npz"]) == [("prep/missing.npz", None)]
    assert bucket.downloads == 0
