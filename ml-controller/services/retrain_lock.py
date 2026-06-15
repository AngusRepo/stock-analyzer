"""
retrain_lock.py — Persistent retrain idempotency lock (GCS-backed).

The original in-memory `_RETRAIN_LOCK` (retrain_trigger.py:37) has two
known failure modes:

  1. Cross-instance race: Cloud Run autoscaling can run multiple instances
     concurrently. Instance A's in-memory dict is invisible to Instance B,
     so two cron-driven triggers landing on different instances would both
     pay GPU cost.

  2. Restart loss: Cloud Run cold starts clear the dict, so the 10-minute
     TTL is meaningless right after a deploy.

This module moves the lock into GCS as a small JSON blob under
`gs://<configured-lock-bucket>/locks/retrain/<key>.json`. Acquisition is atomic
via `if_generation_match=0` (create-if-absent) — GCS's generation semantics
provide linearizable compare-and-set, so two instances racing on the same
key will have exactly one winner.

The in-memory fast-path is retained as an optimization: within a single
instance, we short-circuit without hitting GCS. The GCS layer is the
source of truth when instances disagree.

Design notes:
  - All I/O is wrapped in try/except; lock-acquire failures default to
    "allow the call to proceed", to preserve availability. The production
    tradeoff here is: duplicate retrain (wasted $) < blocked retrain
    (stale model). Make this explicit.

  - TTL is checked at read time by comparing `acquired_at + ttl_seconds`
    against wall clock. Expired locks are silently overwritten on the
    next acquire attempt using `if_generation_match=<current generation>`.

References:
  - Google Cloud: "Request preconditions" — generation-based CAS
    https://cloud.google.com/storage/docs/request-preconditions
  - Burrows (2006). "The Chubby lock service for loosely-coupled distributed
    systems." OSDI. Canonical reference for object-store-backed locks.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────

DEFAULT_BUCKET = (
    os.environ.get("RETRAIN_LOCK_BUCKET", "").strip()
    or os.environ.get("GCS_BUCKET_NAME", "").strip()
)
LOCK_PREFIX = "locks/retrain/"
# Process-local instance identifier (helps debug cross-instance contention)
_INSTANCE_ID = os.environ.get("K_REVISION") or os.environ.get("HOSTNAME") or f"pid{os.getpid()}"
# In-memory fast-path cache: {lock_key: acquired_at_epoch}
_LOCAL_LOCKS: dict[str, float] = {}


# ── Result types ─────────────────────────────────────────────────────────────

@dataclass
class LockAcquireResult:
    acquired: bool
    reason: str
    existing_acquired_at: Optional[float] = None
    existing_instance: Optional[str] = None
    elapsed_since_acquire: Optional[float] = None
    backend: str = "gcs"  # gcs | memory | disabled


@dataclass
class _LockRecord:
    acquired_at: float
    ttl_seconds: int
    instance_id: str
    metadata: dict

    def to_json(self) -> str:
        return json.dumps({
            "acquired_at": self.acquired_at,
            "ttl_seconds": self.ttl_seconds,
            "instance_id": self.instance_id,
            "metadata": self.metadata,
            "version": 1,
        })

    @staticmethod
    def from_json(s: str) -> "_LockRecord":
        d = json.loads(s)
        return _LockRecord(
            acquired_at=float(d["acquired_at"]),
            ttl_seconds=int(d.get("ttl_seconds", 600)),
            instance_id=str(d.get("instance_id", "?")),
            metadata=dict(d.get("metadata", {})),
        )


# ── GCS client (lazy) ────────────────────────────────────────────────────────

_GCS_CLIENT = None


def _get_bucket(bucket_name: str = DEFAULT_BUCKET):
    """Lazy-init a GCS bucket handle.  Returns None on import/auth failure."""
    global _GCS_CLIENT
    if not bucket_name:
        logger.warning("[retrain_lock] RETRAIN_LOCK_BUCKET / GCS_BUCKET_NAME not set; lock disabled")
        return None
    try:
        if _GCS_CLIENT is None:
            from google.cloud import storage  # type: ignore
            _GCS_CLIENT = storage.Client()
        return _GCS_CLIENT.bucket(bucket_name)
    except Exception as e:
        logger.warning(f"[retrain_lock] GCS client init failed ({e}); lock disabled")
        return None


# ── Public API ───────────────────────────────────────────────────────────────

def acquire(
    lock_key: str,
    ttl_seconds: int = 600,
    metadata: Optional[dict] = None,
    bucket_name: str = DEFAULT_BUCKET,
) -> LockAcquireResult:
    """
    Try to acquire a named lock. Returns a LockAcquireResult.

    On success (acquired=True), caller proceeds with work. On failure
    (acquired=False), caller should skip and return a "skipped" status.

    Fast path (single instance): in-memory dict check first, avoids a GCS
    round-trip when the same instance re-triggers within TTL.

    Slow path: GCS blob. Acquisition uses `if_generation_match=0` for
    atomic create-if-absent. If the blob exists but is expired (acquired_at
    + ttl < now), we overwrite it with the current generation.
    """
    now = time.time()

    # ── Fast path: in-memory cache ──────────────────────────────────────────
    local_ts = _LOCAL_LOCKS.get(lock_key)
    if local_ts is not None:
        elapsed = now - local_ts
        if elapsed < ttl_seconds:
            return LockAcquireResult(
                acquired=False,
                reason=f"in-memory lock held {elapsed:.0f}s ago (ttl={ttl_seconds}s)",
                existing_acquired_at=local_ts,
                existing_instance=_INSTANCE_ID,
                elapsed_since_acquire=elapsed,
                backend="memory",
            )
        else:
            # local cache expired; purge
            _LOCAL_LOCKS.pop(lock_key, None)

    # ── Slow path: GCS CAS ──────────────────────────────────────────────────
    bucket = _get_bucket(bucket_name)
    if bucket is None:
        # GCS unavailable: degrade to in-memory only (log the risk)
        _LOCAL_LOCKS[lock_key] = now
        return LockAcquireResult(
            acquired=True,
            reason="GCS unavailable; in-memory lock only (cross-instance at risk)",
            backend="disabled",
        )

    blob_path = f"{LOCK_PREFIX}{lock_key}.json"
    blob = bucket.blob(blob_path)
    record = _LockRecord(
        acquired_at=now,
        ttl_seconds=ttl_seconds,
        instance_id=_INSTANCE_ID,
        metadata=metadata or {},
    )

    # Try atomic create-if-absent first.
    try:
        blob.upload_from_string(
            record.to_json(),
            content_type="application/json",
            if_generation_match=0,
        )
        _LOCAL_LOCKS[lock_key] = now
        return LockAcquireResult(acquired=True, reason="acquired_new")
    except Exception as e:
        # Distinguish "blob exists" from "real error" via the GCS precondition class
        if "412" not in str(e) and "Precondition" not in e.__class__.__name__:
            # Unexpected error: fail open (allow the call to proceed)
            logger.warning(f"[retrain_lock] acquire CAS failed unexpectedly: {e}; failing open")
            _LOCAL_LOCKS[lock_key] = now
            return LockAcquireResult(
                acquired=True,
                reason=f"acquire_error_fail_open ({str(e)[:80]})",
                backend="disabled",
            )
        # else: precondition failed → blob exists, need to inspect it

    # Read existing blob to decide whether to overwrite (expired) or skip.
    try:
        blob.reload()
        existing_text = blob.download_as_text()
        existing = _LockRecord.from_json(existing_text)
        elapsed = now - existing.acquired_at
        if elapsed < existing.ttl_seconds:
            return LockAcquireResult(
                acquired=False,
                reason=f"held_by_{existing.instance_id} {elapsed:.0f}s ago (ttl={existing.ttl_seconds}s)",
                existing_acquired_at=existing.acquired_at,
                existing_instance=existing.instance_id,
                elapsed_since_acquire=elapsed,
            )
        # Expired: take over via generation-match
        current_gen = blob.generation
        blob.upload_from_string(
            record.to_json(),
            content_type="application/json",
            if_generation_match=current_gen,
        )
        _LOCAL_LOCKS[lock_key] = now
        return LockAcquireResult(
            acquired=True,
            reason=f"took_over_expired (prev_instance={existing.instance_id}, elapsed={elapsed:.0f}s)",
        )
    except Exception as e:
        logger.warning(f"[retrain_lock] acquire take-over path failed: {e}; failing open")
        _LOCAL_LOCKS[lock_key] = now
        return LockAcquireResult(
            acquired=True,
            reason=f"takeover_error_fail_open ({str(e)[:80]})",
            backend="disabled",
        )


def release(
    lock_key: str,
    expected_metadata: Optional[dict] = None,
    bucket_name: str = DEFAULT_BUCKET,
) -> bool:
    """
    Release the lock (delete the blob + purge in-memory entry).
    Non-fatal on any error. Returns True if the blob was removed or was
    already absent, False on hard error.
    """
    bucket = _get_bucket(bucket_name)
    if bucket is None:
        _LOCAL_LOCKS.pop(lock_key, None)
        return True
    try:
        blob = bucket.blob(f"{LOCK_PREFIX}{lock_key}.json")
        if expected_metadata:
            if not blob.exists():
                _LOCAL_LOCKS.pop(lock_key, None)
                return True
            existing = _LockRecord.from_json(blob.download_as_text())
            mismatches = {
                str(key): {
                    "expected": str(value),
                    "actual": str(existing.metadata.get(key)),
                }
                for key, value in expected_metadata.items()
                if str(existing.metadata.get(key)) != str(value)
            }
            if mismatches:
                logger.warning(
                    "[retrain_lock] release skipped for %s due metadata mismatch: %s",
                    lock_key,
                    mismatches,
                )
                return False
        blob.delete()
        _LOCAL_LOCKS.pop(lock_key, None)
    except Exception as e:
        # 404 is fine (already released); anything else is logged
        msg = str(e)
        if "404" in msg or "Not Found" in msg or "No such object" in msg:
            _LOCAL_LOCKS.pop(lock_key, None)
            return True
        logger.warning(f"[retrain_lock] release failed for {lock_key}: {e}")
        return False
    return True


def inspect(
    lock_key: str,
    bucket_name: str = DEFAULT_BUCKET,
) -> Optional[dict]:
    """Return the current lock record (or None if absent/unreadable)."""
    bucket = _get_bucket(bucket_name)
    if bucket is None:
        return None
    try:
        blob = bucket.blob(f"{LOCK_PREFIX}{lock_key}.json")
        if not blob.exists():
            return None
        rec = _LockRecord.from_json(blob.download_as_text())
        now = time.time()
        return {
            "acquired_at": rec.acquired_at,
            "ttl_seconds": rec.ttl_seconds,
            "instance_id": rec.instance_id,
            "metadata": rec.metadata,
            "elapsed": now - rec.acquired_at,
            "expired": (now - rec.acquired_at) >= rec.ttl_seconds,
        }
    except Exception as e:
        logger.debug(f"[retrain_lock] inspect failed: {e}")
        return None


# ── Test utilities (DO NOT USE IN PRODUCTION CODE PATHS) ─────────────────────

def _clear_local_cache() -> None:
    """Clear the in-memory fast-path. Only for tests."""
    _LOCAL_LOCKS.clear()
