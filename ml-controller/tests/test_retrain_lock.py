"""
test_retrain_lock.py — Unit tests for GCS-backed retrain idempotency lock.

Uses a fake GCS bucket to exercise the acquire/release/inspect flow
without requiring real cloud credentials.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import retrain_lock  # noqa: E402


# ─── Fake GCS infrastructure ────────────────────────────────────────────────

class _FakeBlob:
    def __init__(self, bucket: "_FakeBucket", name: str):
        self._bucket = bucket
        self.name = name
        self._data: str | None = None
        self._generation: int = 0

    def exists(self) -> bool:
        return self._data is not None

    def upload_from_string(
        self,
        data: str,
        content_type: str = "application/json",
        if_generation_match: int | None = None,
    ) -> None:
        if if_generation_match is not None and if_generation_match != self._generation:
            # Mimic GCS 412 Precondition Failed
            raise Exception("412 Precondition Failed")
        self._data = data
        self._generation += 1

    def download_as_text(self) -> str:
        if self._data is None:
            raise Exception("404 Not Found")
        return self._data

    def reload(self) -> None:
        return None

    @property
    def generation(self) -> int:
        return self._generation

    def delete(self) -> None:
        if self._data is None:
            raise Exception("404 Not Found")
        self._data = None


class _FakeBucket:
    def __init__(self, name: str):
        self.name = name
        self._blobs: dict[str, _FakeBlob] = {}

    def blob(self, path: str) -> _FakeBlob:
        if path not in self._blobs:
            self._blobs[path] = _FakeBlob(self, path)
        return self._blobs[path]


@pytest.fixture(autouse=True)
def _isolate_local_cache():
    """Clear in-memory cache between tests so order doesn't matter."""
    retrain_lock._clear_local_cache()
    yield
    retrain_lock._clear_local_cache()


@pytest.fixture
def fake_bucket(monkeypatch):
    """Install a fake bucket so tests don't hit real GCS."""
    bucket = _FakeBucket("test-bucket")
    monkeypatch.setattr(retrain_lock, "_get_bucket", lambda name=None: bucket)
    return bucket


# ─── acquire() behavior ────────────────────────────────────────────────────

class TestAcquire:
    def test_first_acquire_succeeds(self, fake_bucket):
        r = retrain_lock.acquire("test:2026-01-01", ttl_seconds=600)
        assert r.acquired is True
        assert r.reason == "acquired_new"

    def test_duplicate_acquire_same_instance_uses_memory(self, fake_bucket):
        r1 = retrain_lock.acquire("test:dup", ttl_seconds=600)
        r2 = retrain_lock.acquire("test:dup", ttl_seconds=600)
        assert r1.acquired is True
        assert r2.acquired is False
        assert r2.backend == "memory"

    def test_cross_instance_second_acquire_fails(self, fake_bucket):
        # First instance acquires
        r1 = retrain_lock.acquire("test:x", ttl_seconds=600)
        assert r1.acquired is True
        # Simulate different instance: clear in-memory cache but keep GCS
        retrain_lock._clear_local_cache()
        r2 = retrain_lock.acquire("test:x", ttl_seconds=600)
        assert r2.acquired is False
        assert "held_by" in r2.reason

    def test_expired_lock_can_be_taken_over(self, fake_bucket):
        # Acquire with 10-second TTL, then rewind the timestamp by 1 hour
        r1 = retrain_lock.acquire("test:expired", ttl_seconds=10)
        assert r1.acquired is True
        # Rewrite the blob contents with an old timestamp
        blob = fake_bucket.blob("locks/retrain/test:expired.json")
        import json as _json
        rec = _json.loads(blob.download_as_text())
        rec["acquired_at"] = time.time() - 3600  # 1 hour ago
        blob._data = _json.dumps(rec)
        # Different instance tries to acquire
        retrain_lock._clear_local_cache()
        r2 = retrain_lock.acquire("test:expired", ttl_seconds=10)
        assert r2.acquired is True
        assert "took_over_expired" in r2.reason

    def test_gcs_unavailable_degrades_to_memory_fail_open(self, monkeypatch):
        monkeypatch.setattr(retrain_lock, "_get_bucket", lambda name=None: None)
        r1 = retrain_lock.acquire("test:no_gcs", ttl_seconds=600)
        assert r1.acquired is True
        assert r1.backend == "disabled"
        # Second call within TTL should still be blocked by in-memory cache
        r2 = retrain_lock.acquire("test:no_gcs", ttl_seconds=600)
        assert r2.acquired is False
        assert r2.backend == "memory"

    def test_metadata_preserved_in_blob(self, fake_bucket):
        retrain_lock.acquire(
            "test:meta", ttl_seconds=600,
            metadata={"fingerprint": "abc123", "regime": "bull"},
        )
        info = retrain_lock.inspect("test:meta")
        assert info is not None
        assert info["metadata"]["fingerprint"] == "abc123"
        assert info["metadata"]["regime"] == "bull"


# ─── release() behavior ────────────────────────────────────────────────────

class TestRelease:
    def test_release_clears_blob(self, fake_bucket):
        retrain_lock.acquire("test:rel", ttl_seconds=600)
        ok = retrain_lock.release("test:rel")
        assert ok is True
        assert retrain_lock.inspect("test:rel") is None

    def test_release_absent_blob_is_ok(self, fake_bucket):
        # Never acquired; release should silently succeed
        ok = retrain_lock.release("test:never")
        assert ok is True

    def test_release_after_release_idempotent(self, fake_bucket):
        retrain_lock.acquire("test:double_release", ttl_seconds=600)
        assert retrain_lock.release("test:double_release") is True
        assert retrain_lock.release("test:double_release") is True

    def test_release_purges_local_cache(self, fake_bucket):
        retrain_lock.acquire("test:cache_purge", ttl_seconds=600)
        retrain_lock.release("test:cache_purge")
        # Subsequent acquire should succeed (not blocked by memory cache)
        r = retrain_lock.acquire("test:cache_purge", ttl_seconds=600)
        assert r.acquired is True

    def test_release_with_metadata_mismatch_preserves_blob(self, fake_bucket):
        retrain_lock.acquire(
            "test:owner_guard",
            ttl_seconds=600,
            metadata={"run_id": "new-run"},
        )
        retrain_lock._clear_local_cache()

        ok = retrain_lock.release(
            "test:owner_guard",
            expected_metadata={"run_id": "old-run"},
        )

        assert ok is False
        info = retrain_lock.inspect("test:owner_guard")
        assert info is not None
        assert info["metadata"]["run_id"] == "new-run"

    def test_release_with_matching_metadata_clears_blob(self, fake_bucket):
        retrain_lock.acquire(
            "test:owner_guard_match",
            ttl_seconds=600,
            metadata={"run_id": "same-run"},
        )

        ok = retrain_lock.release(
            "test:owner_guard_match",
            expected_metadata={"run_id": "same-run"},
        )

        assert ok is True
        assert retrain_lock.inspect("test:owner_guard_match") is None


# ─── inspect() behavior ───────────────────────────────────────────────────

class TestInspect:
    def test_inspect_returns_none_for_absent(self, fake_bucket):
        assert retrain_lock.inspect("test:absent") is None

    def test_inspect_returns_record(self, fake_bucket):
        retrain_lock.acquire("test:insp", ttl_seconds=600, metadata={"run": 1})
        info = retrain_lock.inspect("test:insp")
        assert info is not None
        assert info["ttl_seconds"] == 600
        assert info["metadata"]["run"] == 1
        assert info["expired"] is False
        assert info["elapsed"] >= 0

    def test_inspect_marks_expired_correctly(self, fake_bucket):
        retrain_lock.acquire("test:exp_insp", ttl_seconds=10)
        blob = fake_bucket.blob("locks/retrain/test:exp_insp.json")
        import json as _json
        rec = _json.loads(blob.download_as_text())
        rec["acquired_at"] = time.time() - 3600
        blob._data = _json.dumps(rec)
        info = retrain_lock.inspect("test:exp_insp")
        assert info is not None
        assert info["expired"] is True
