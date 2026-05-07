from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.dataset_snapshots import (  # noqa: E402
    resolve_snapshot_store_role,
    validate_dataset_snapshot_manifest,
)


def test_compute_snapshots_are_gcs_primary():
    role = resolve_snapshot_store_role("compute")

    assert role["primary_store"] == "gcs"
    assert role["requires_gcs"] is True
    assert role["requires_r2"] is False


def test_report_and_preview_snapshots_are_r2_primary():
    assert resolve_snapshot_store_role("report")["primary_store"] == "r2"
    assert resolve_snapshot_store_role("preview")["primary_store"] == "r2"


def test_manifest_validation_rejects_shadow_only_store_mismatch():
    errors = validate_dataset_snapshot_manifest({
        "snapshot_id": "snap-1",
        "kind": "backtest_report",
        "business_date": "2026-05-06",
        "schema_version": "v1",
        "row_count": 10,
        "checksum": "abc",
        "primary_store": "gcs",
        "access_tier": "report",
        "producer_run_id": "run-1",
        "gcs_uri": "gs://stockvision-models/reports/snap-1.json",
    })

    assert "primary_store_mismatch:gcs->r2" in errors
    assert "r2_key_required" in errors


def test_manifest_validation_accepts_compute_gcs_and_report_r2():
    compute_errors = validate_dataset_snapshot_manifest({
        "snapshot_id": "snap-compute",
        "kind": "price_history",
        "business_date": "2026-05-06",
        "schema_version": "prices-v1",
        "row_count": 2000,
        "checksum": "sha256:x",
        "primary_store": "gcs",
        "access_tier": "compute",
        "producer_run_id": "evening-chain",
        "gcs_uri": "gs://stockvision-models/datasets/prices/2026-05-06.parquet",
    })
    report_errors = validate_dataset_snapshot_manifest({
        "snapshot_id": "snap-report",
        "kind": "screener_funnel_preview",
        "business_date": "2026-05-06",
        "schema_version": "funnel-v1",
        "row_count": 80,
        "checksum": "sha256:y",
        "primary_store": "r2",
        "access_tier": "preview",
        "producer_run_id": "screener",
        "r2_key": "previews/screener/2026-05-06.json",
    })

    assert compute_errors == []
    assert report_errors == []
