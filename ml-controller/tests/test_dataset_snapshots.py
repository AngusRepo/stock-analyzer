from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.dataset_snapshots import (  # noqa: E402
    build_dataset_snapshot_manifest,
    latest_dataset_snapshot,
    resolve_snapshot_store_role,
    upsert_dataset_snapshot_manifest,
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

    def fake_query(sql, params, timeout=60.0):
        captured["sql"] = sql
        captured["params"] = params
        captured["timeout"] = timeout
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

    class FakeLearningClient:
        query = staticmethod(fake_query)

    def fake_client_for_domain(domain):
        captured["domain"] = domain
        return FakeLearningClient()

    monkeypatch.setattr("services.dataset_snapshots.client_for_domain", fake_client_for_domain)

    row = latest_dataset_snapshot(
        kind="backtest_dataset",
        access_tier="compute",
        as_of_business_date="2026-05-07",
    )

    assert row["snapshot_id"] == "snap-2026-05-06"
    assert "business_date <= ?" in captured["sql"]
    assert captured["params"] == ["backtest_dataset", "compute", "2026-05-07"]
    assert captured["domain"] == "learning"


def test_upsert_dataset_snapshot_routes_to_learning_domain(monkeypatch):
    captured = {}

    class FakeLearningClient:
        def execute(self, sql, params, timeout=60.0):
            captured.update(sql=sql, params=params, timeout=timeout)
            return {"success": True, "meta": {"changes": 1}, "results": []}

    def fake_client_for_domain(domain):
        captured["domain"] = domain
        return FakeLearningClient()

    monkeypatch.setattr("services.dataset_snapshots.client_for_domain", fake_client_for_domain)
    manifest = build_dataset_snapshot_manifest(
        snapshot_id="backtest_dataset:2026-08-18:test",
        kind="backtest_dataset",
        business_date="2026-08-18",
        schema_version="backtest-dataset-parquet-v2",
        row_count=10,
        checksum="sha256:test",
        access_tier="compute",
        producer_run_id="test",
        gcs_uri="gs://stockvision-models/test",
    )

    result = upsert_dataset_snapshot_manifest(manifest)

    assert result["meta"]["changes"] == 1
    assert captured["domain"] == "learning"
    assert "INSERT OR REPLACE INTO dataset_snapshots" in captured["sql"]


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
