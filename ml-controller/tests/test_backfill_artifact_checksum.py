from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "backfill_artifact_checksum.py"
SPEC = importlib.util.spec_from_file_location("backfill_artifact_checksum", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeBlob:
    def __init__(self, name: str, raw: bytes = b"", generation: int = 1):
        self.name = name
        self.raw = raw
        self.generation = generation
        self.time_created = datetime(2026, 6, 19, tzinfo=timezone.utc)
        self.uploads: list[dict] = []

    def download_as_bytes(self) -> bytes:
        return self.raw

    def upload_from_string(self, raw, **kwargs) -> None:
        self.uploads.append({"raw": raw, **kwargs})


class FakeBucket:
    def __init__(self, blobs: dict[str, FakeBlob]):
        self.blobs = blobs

    def get_blob(self, path: str):
        return self.blobs.get(path)

    def blob(self, path: str) -> FakeBlob:
        return self.blobs.setdefault(path, FakeBlob(path))


def _install_client(monkeypatch, metadata: dict):
    artifact = FakeBlob("artifact.pt", b"weights", generation=11)
    metadata_blob = FakeBlob(
        "metadata.json",
        json.dumps(metadata).encode(),
        generation=12,
    )
    bucket = FakeBucket({"artifact.pt": artifact, "metadata.json": metadata_blob})
    client = type("Client", (), {"bucket": lambda self, _: bucket})()
    monkeypatch.setattr(MODULE.storage, "Client", lambda: client)
    return bucket, metadata_blob


def _run(*, apply: bool):
    return MODULE.backfill_checksum(
        bucket_name="bucket",
        model_name="DLinear",
        version="v1",
        artifact_path="artifact.pt",
        metadata_path="metadata.json",
        apply=apply,
    )


def test_dry_run_does_not_write(monkeypatch):
    bucket, metadata_blob = _install_client(monkeypatch, {"version": "v1"})

    report = _run(apply=False)

    assert report["status"] == "ready"
    assert report["checksum"] == MODULE._sha256(b"weights")
    assert metadata_blob.uploads == []
    assert set(bucket.blobs) == {"artifact.pt", "metadata.json"}


def test_apply_backs_up_and_uses_generation_precondition(monkeypatch):
    bucket, metadata_blob = _install_client(monkeypatch, {"version": "v1"})

    report = _run(apply=True)

    assert report["status"] == "applied"
    backup = bucket.blobs[report["backup_path"]]
    assert backup.uploads[0]["if_generation_match"] == 0
    assert metadata_blob.uploads[0]["if_generation_match"] == 12
    written = json.loads(metadata_blob.uploads[0]["raw"])
    assert written["checksum"] == MODULE._sha256(b"weights")
    assert written["artifact_integrity_migration"]["backup_path"] == report["backup_path"]


def test_existing_checksum_mismatch_is_rejected(monkeypatch):
    _install_client(monkeypatch, {"version": "v1", "checksum": "sha256:wrong"})

    with pytest.raises(ValueError, match="existing checksum mismatch"):
        _run(apply=True)
