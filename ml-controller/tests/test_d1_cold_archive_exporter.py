from __future__ import annotations

import json
import sys
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import dataset_snapshot_exporter as exporter  # noqa: E402


class FakeBucket:
    name = "stockvision-models"


class DummyTempDir:
    def __enter__(self):
        path = Path(".tmp") / "pytest-d1-cold-archive-dummy"
        path.mkdir(parents=True, exist_ok=True)
        return str(path)

    def __exit__(self, exc_type, exc, tb):
        return False


def test_export_d1_cold_archive_registers_gcs_archive_manifest(monkeypatch):
    captured: dict[str, object] = {}

    def fake_query_date_range(sql: str, start_date: str, end_date: str, chunk_days: int):
        if "FROM stock_prices" in sql:
            return pl.DataFrame([
                {"stock_id": "2330", "date": "2024-01-02", "close": 100.0},
            ]), 1
        if "FROM margin_data" in sql:
            return pl.DataFrame([
                {"stock_id": "2330", "date": "2024-01-02", "margin_balance": 10},
            ]), 1
        return pl.DataFrame(), 1

    def fake_write_component(bucket, prefix: str, name: str, df: pl.DataFrame, tmp_dir: Path):
        return {
            "name": name,
            "row_count": len(df),
            "gcs_uri": f"gs://{bucket.name}/{prefix}/{name}.parquet",
            "columns": list(df.columns),
            "bytes": 128,
        }

    def fake_upsert(manifest: dict):
        captured["manifest"] = manifest
        return {"success": True}

    monkeypatch.setattr(exporter, "_gcs_client_bucket", lambda: (FakeBucket(), FakeBucket.name))
    monkeypatch.setattr(exporter, "_query_date_range", fake_query_date_range)
    monkeypatch.setattr(exporter, "_write_component_to_gcs", fake_write_component)
    monkeypatch.setattr(exporter, "_temporary_directory", lambda prefix: DummyTempDir())
    monkeypatch.setattr(exporter, "upsert_dataset_snapshot_manifest", fake_upsert)
    monkeypatch.setenv("STOCKVISION_TMP_DIR", str(Path(".tmp") / "pytest-d1-cold-archive"))

    result = exporter.export_d1_cold_archive_snapshot(exporter.D1ColdArchiveExportRequest(
        business_date="2026-05-19",
        start_date="2024-01-01",
        end_date="2024-12-31",
        tables=("stock_prices", "margin_data"),
        producer_run_id="retention-dry-run",
    ))

    manifest = captured["manifest"]
    assert result["status"] == "ready"
    assert manifest["kind"] == "d1_cold_archive"
    assert manifest["access_tier"] == "archive"
    assert manifest["primary_store"] == "gcs"
    assert manifest["gcs_uri"].startswith("gs://stockvision-models/archives/d1_cold_archive/")

    metadata = json.loads(manifest["metadata_json"])
    assert metadata["source"] == "stockvision_d1_exact"
    assert metadata["hot_window_days"] == 504
    assert metadata["delete_requires_manual_approval"] is True
    assert {row["table"] for row in metadata["table_coverage"]} == {"stock_prices", "margin_data"}
    assert all(row["coverage_start"] == "2024-01-01" for row in metadata["table_coverage"])
    assert all(row["coverage_end"] == "2024-12-31" for row in metadata["table_coverage"])


def test_build_finlab_5y_raw_archive_metadata_uses_existing_manifest():
    manifest_dir = Path(".tmp") / "pytest-finlab-raw-archive"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / "manifest.json"
    manifest_path.write_text(json.dumps({
        "run_id": "finlab-v4-5y-20260518-024944",
        "lookback_years": 5,
        "dataset_count": 2,
        "finlab_rows": 10,
        "missing_in_stockvision": 4,
        "value_conflicts": 0,
        "datasets": {
            "daily_price": {
                "rows": 6,
                "min_date": "2021-05-18",
                "max_date": "2026-05-15",
                "artifacts": ["close.parquet"],
            },
            "emerging_chip_diversity": {
                "rows": 4,
                "min_date": "2021-05-18",
                "max_date": "2026-05-15",
                "artifacts": ["rotc_broker_daily.parquet"],
            },
        },
    }), encoding="utf-8")

    metadata = exporter.build_finlab_5y_raw_archive_metadata(exporter.FinLabRawArchiveMetadataRequest(
        manifest_path=str(manifest_path),
        business_date="2026-05-19",
        producer_run_id="p1-archive-plan",
        gcs_uri="gs://stockvision-models/finlab/raw/finlab-v4-5y-20260518-024944",
    ))

    assert metadata["source"] == "finlab_5y_raw"
    assert metadata["run_id"] == "finlab-v4-5y-20260518-024944"
    assert metadata["dataset_count"] == 2
    assert metadata["finlab_rows"] == 10
    assert {row["dataset"] for row in metadata["dataset_coverage"]} == {
        "daily_price",
        "emerging_chip_diversity",
    }
