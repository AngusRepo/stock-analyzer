from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ml-controller'))
sys.path.insert(0, str(ROOT / 'ml-service'))

from services import active8_prep_lifecycle as lifecycle
from services import modal_client, walk_forward_retrain
from routers import retrain_trigger
from app.long_history_sequence_prep import _manifest_checksum as producer_manifest_checksum

TEST_SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"
os.environ.setdefault("STOCKVISION_SOURCE_SHA", TEST_SOURCE_SHA)


class _Blob:
    def __init__(self, store: dict[str, bytes], name: str):
        self.store = store
        self.name = name

    def exists(self) -> bool:
        return self.name in self.store

    def download_as_bytes(self) -> bytes:
        return self.store[self.name]

    def download_as_text(self) -> str:
        return self.store[self.name].decode("utf-8")

    def upload_from_string(self, value, content_type: str | None = None) -> None:
        del content_type
        self.store[self.name] = value.encode("utf-8") if isinstance(value, str) else bytes(value)


class _Bucket:
    def __init__(self):
        self.store: dict[str, bytes] = {}

    def blob(self, name: str) -> _Blob:
        return _Blob(self.store, name)

    def list_blobs(self, prefix: str):
        return [_Blob(self.store, name) for name in sorted(self.store) if name.startswith(prefix)]


def _seal_sequence(bucket: _Bucket, *, date_max: str = "2026-07-24") -> tuple[str, dict]:
    prefix = "universal/sequence_long/runs/finlab-v4-daily-20260724"
    batch_path = f"{prefix}/prep/batch_0.npz"
    bucket.store[batch_path] = b"sequence-batch"
    manifest = {
        "schema_version": "finlab-long-history-sequence-prep-v2",
        "status": "ready",
        "created_at": "2026-07-24T14:00:00+00:00",
        "contract": "sequence_records_v3",
        "output_gcs_prefix": prefix,
        "batch_count": 1,
        "batch_rows": [100],
        "summary": {"date_min": "2025-01-02", "date_max": date_max},
        "output_checksums": {batch_path: hashlib.sha256(bucket.store[batch_path]).hexdigest()},
    }
    manifest["manifest_checksum"] = lifecycle._manifest_checksum(manifest)
    bucket.store[f"{prefix}/prep/sequence_manifest.json"] = json.dumps(manifest).encode("utf-8")
    return prefix, manifest


def _snapshot(*, prefixed_checksum: bool = False, business_date: str = "2026-07-24") -> dict:
    checksum = "a" * 64
    start_date = (
        datetime.strptime(business_date, "%Y-%m-%d")
        - timedelta(days=lifecycle.ACTIVE8_COMPUTE_SNAPSHOT_LOOKBACK_DAYS)
    ).date().isoformat()
    return {
        "snapshot_id": "snapshot-20260724",
        "business_date": business_date,
        "checksum": f"sha256:{checksum}" if prefixed_checksum else checksum,
        "manifest_errors": [],
        "metadata_json": json.dumps({"start_date": start_date}),
    }


def _market_query(_sql, params):
    assert params == ["2026-07-25", "2026-07-25"]
    return [
        {"trading_date": "2026-07-23", "price_rows": 1900},
        {"trading_date": "2026-07-24", "price_rows": 1950},
    ]


def test_sequence_manifest_checksum_matches_producer_contract():
    manifest = {
        "schema_version": "finlab-long-history-sequence-prep-v2",
        "status": "ready",
        "contract": "sequence_records_v3",
        "output_gcs_prefix": "universal/sequence_long/runs/example",
        "batch_count": 1,
        "summary": {"date_min": "2025-01-02", "date_max": "2026-07-23"},
        "output_checksums": {"batch_0.npz": "a" * 64},
    }

    assert lifecycle._manifest_checksum(manifest) == producer_manifest_checksum(manifest)

def test_daily_prep_dry_run_resolves_latest_legal_business_date(monkeypatch):
    bucket = _Bucket()
    prefix, manifest = _seal_sequence(bucket)
    monkeypatch.setattr(lifecycle, "latest_dataset_snapshot", lambda **_kwargs: _snapshot())
    monkeypatch.setattr(walk_forward_retrain, "_get_bucket", lambda: bucket)

    result = asyncio.run(lifecycle.ensure_active8_daily_prep(
        end_date="2026-07-25", dry_run=True, query_fn=_market_query,
    ))

    assert result["status"] == "dry_run"
    assert result["business_date"] == "2026-07-24"
    assert result["sequence_gcs_prefix"] == prefix
    assert result["sequence_manifest_checksum"] == manifest["manifest_checksum"]
    assert result["source_gcs_prefix"].startswith("universal/oof_forward_prep_v2/2026-07-24-")

def test_daily_prep_accepts_canonical_prefixed_snapshot_checksum(monkeypatch):
    bucket = _Bucket()
    _seal_sequence(bucket)
    monkeypatch.setattr(
        lifecycle,
        "latest_dataset_snapshot",
        lambda **_kwargs: _snapshot(prefixed_checksum=True),
    )
    monkeypatch.setattr(walk_forward_retrain, "_get_bucket", lambda: bucket)

    result = asyncio.run(lifecycle.ensure_active8_daily_prep(
        end_date="2026-07-25", dry_run=True, query_fn=_market_query,
    ))

    assert result["snapshot_checksum"] == "a" * 64
    assert result["source_gcs_prefix"].endswith(f"-aaaaaaaaaaaa-{TEST_SOURCE_SHA[:12]}")


def test_daily_prep_rejects_sequence_behind_snapshot(monkeypatch):
    bucket = _Bucket()
    _seal_sequence(bucket, date_max="2026-07-23")
    monkeypatch.setattr(lifecycle, "latest_dataset_snapshot", lambda **_kwargs: _snapshot())
    monkeypatch.setattr(walk_forward_retrain, "_get_bucket", lambda: bucket)

    with pytest.raises(lifecycle.Active8PrepDependencyPending) as exc:
        asyncio.run(lifecycle.ensure_active8_daily_prep(
            end_date="2026-07-25", query_fn=_market_query,
        ))

    assert exc.value.reason == "immutable_sequence_behind_compute_snapshot"


def test_daily_prep_rejects_snapshot_behind_latest_market_session(monkeypatch):
    monkeypatch.setattr(
        lifecycle,
        "latest_dataset_snapshot",
        lambda **_kwargs: _snapshot(business_date="2026-07-23"),
    )

    with pytest.raises(lifecycle.Active8PrepDependencyPending) as exc:
        asyncio.run(lifecycle.ensure_active8_daily_prep(
            end_date="2026-07-25", query_fn=_market_query,
        ))

    assert exc.value.reason == "compute_snapshot_behind_market_session"
    assert exc.value.evidence["expected_business_date"] == "2026-07-24"
    assert exc.value.evidence["snapshot_business_date"] == "2026-07-23"


def test_daily_prep_rejects_short_compute_snapshot_history(monkeypatch):
    snapshot = _snapshot()
    snapshot["metadata_json"] = json.dumps({"start_date": "2026-06-24"})
    monkeypatch.setattr(lifecycle, "latest_dataset_snapshot", lambda **_kwargs: snapshot)

    with pytest.raises(lifecycle.Active8PrepDependencyPending) as exc:
        asyncio.run(lifecycle.ensure_active8_daily_prep(
            end_date="2026-07-25", query_fn=_market_query,
        ))

    assert exc.value.reason == "compute_snapshot_history_insufficient"
    assert exc.value.evidence["snapshot_start_date"] == "2026-06-24"
    assert exc.value.evidence["required_lookback_days"] == 504


def test_daily_prep_builds_feature_and_adjusted_receipts(monkeypatch):
    bucket = _Bucket()
    _prefix, sequence_manifest = _seal_sequence(bucket)
    monkeypatch.setattr(lifecycle, "latest_dataset_snapshot", lambda **_kwargs: _snapshot())
    monkeypatch.setattr(walk_forward_retrain, "_get_bucket", lambda: bucket)

    async def fake_prep(req, request=None):
        del request
        assert req.prep_only is True
        assert req.require_exact_dataset_snapshot is True
        return {
            "status": "ready",
            "batch_count": 5,
            "receipt_checksum": "b" * 64,
        }

    async def fake_adjusted(payload):
        assert payload["source_gcs_prefix"].startswith("universal/oof_forward_prep_v2/2026-07-24-")
        assert payload["sequence_gcs_prefix"] == _prefix
        assert payload["sequence_batch_count"] == 1
        return {
            "schema_version": lifecycle.ADJUSTED_PREP_SCHEMA,
            "feature_semantic_version": lifecycle.FEATURE_SEMANTIC_VERSION,
            "feature_imputation_semantic": lifecycle.FEATURE_IMPUTATION_SEMANTIC_VERSION,
            "producer_source_sha": TEST_SOURCE_SHA,
            "manifest_checksum": "c" * 64,
            "source_feature_date_max": "2026-07-24",
            "signal_date_max": "2026-07-17",
            "label_known_date_max": "2026-07-24",
        }

    monkeypatch.setattr(retrain_trigger, "trigger_universal_retrain", fake_prep)
    monkeypatch.setattr(modal_client, "rebuild_canonical_adjusted_prep", fake_adjusted)

    result = asyncio.run(lifecycle.ensure_active8_daily_prep(
        end_date="2026-07-25", query_fn=_market_query,
    ))

    assert result["status"] == "ready"
    assert result["signal_date_max"] == "2026-07-17"
    assert result["sequence_manifest_checksum"] == sequence_manifest["manifest_checksum"]
    assert result["receipt_path"] in bucket.store
