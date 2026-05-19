from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.dataset_snapshots import (  # noqa: E402
    latest_dataset_snapshot,
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


def test_archive_snapshots_are_gcs_primary():
    role = resolve_snapshot_store_role("archive")

    assert role["primary_store"] == "gcs"
    assert role["requires_gcs"] is True
    assert role["requires_r2"] is False


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


def test_manifest_validation_accepts_compute_gcs_report_r2_and_archive_gcs():
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
    archive_errors = validate_dataset_snapshot_manifest({
        "snapshot_id": "snap-archive",
        "kind": "d1_cold_archive",
        "business_date": "2026-05-06",
        "schema_version": "d1-cold-archive-v1",
        "row_count": 2000,
        "checksum": "sha256:z",
        "primary_store": "gcs",
        "access_tier": "archive",
        "producer_run_id": "d1-archive",
        "gcs_uri": "gs://stockvision-models/d1-cold-archive/2026-05-06",
    })

    assert compute_errors == []
    assert report_errors == []
    assert archive_errors == []


def test_latest_dataset_snapshot_supports_as_of_business_date(monkeypatch):
    captured = {}

    def fake_query(sql, params):
        captured["sql"] = sql
        captured["params"] = params
        return [{
            "snapshot_id": "snap-2026-05-06",
            "kind": "backtest_dataset",
            "business_date": "2026-05-06",
            "schema_version": "v1",
            "row_count": 10,
            "checksum": "sha256:x",
            "primary_store": "gcs",
            "access_tier": "compute",
            "producer_run_id": "evening-chain",
            "gcs_uri": "gs://stockvision-models/datasets/backtest/2026-05-06",
            "status": "ready",
        }]

    monkeypatch.setattr("services.dataset_snapshots.d1_client.query", fake_query)

    row = latest_dataset_snapshot(
        kind="backtest_dataset",
        access_tier="compute",
        as_of_business_date="2026-05-07",
    )

    assert row["snapshot_id"] == "snap-2026-05-06"
    assert "business_date <= ?" in captured["sql"]
    assert captured["params"] == ["backtest_dataset", "compute", "2026-05-07"]


def test_latest_dataset_snapshot_rejects_conflicting_date_filters():
    try:
        latest_dataset_snapshot(
            kind="backtest_dataset",
            access_tier="compute",
            business_date="2026-05-06",
            as_of_business_date="2026-05-07",
        )
    except ValueError as exc:
        assert str(exc) == "dataset_snapshot_date_filter_conflict"
    else:
        raise AssertionError("expected conflict error")
