from __future__ import annotations

import sys
from uuid import uuid4
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_backfill_runtime import (  # noqa: E402
    FinLabBackfillRequest,
    FinLabLocalBackfillStore,
    build_gap_fill_rows,
    build_source_diff_report,
    finlab_backfill_run_d1_row,
    materialize_finlab_dataset,
    run_finlab_backfill_diff,
    source_diff_report_d1_rows,
)


ROOT = Path(__file__).resolve().parents[2]


def _workspace_tmp(name: str) -> Path:
    path = ROOT / ".tmp" / "v4_1_runtime_tests" / f"{name}-{uuid4().hex}"
    path.mkdir(parents=True, exist_ok=True)
    return path


class FakeFinLabAdapter:
    def __init__(self, datasets):
        self.datasets = datasets

    def get_dataset(self, api_key: str):
        return self.datasets[api_key]


def test_materialize_finlab_dataset_normalizes_rows_and_writes_local_artifacts():
    adapter = FakeFinLabAdapter(
        {
            "price:close": [
                {"stock_id": "2330", "date": "2026-05-15", "close": 900},
                {"stock_id": "2454", "date": "2026-05-15", "close": 1200},
            ]
        }
    )
    store = FinLabLocalBackfillStore(_workspace_tmp("materialize"))

    dataset = materialize_finlab_dataset(
        adapter=adapter,
        request=FinLabBackfillRequest(
            api_key="price:close",
            dataset_lane="daily_price",
            compare_fields=("close",),
        ),
        generated_at="2026-05-16T00:00:00+00:00",
        store=store,
        run_id="run-1",
    )

    assert dataset.row_count == 2
    assert dataset.rows[0]["symbol"] == "2330"
    assert dataset.rows[0]["_source"] == "finlab"
    assert dataset.raw_path and Path(dataset.raw_path).exists()
    assert dataset.clean_path and Path(dataset.clean_path).exists()


def test_source_diff_report_separates_fillable_gaps_from_conflicts():
    finlab_rows = [
        {"symbol": "2330", "date": "2026-05-15", "close": 900},
        {"symbol": "2454", "date": "2026-05-15", "close": 1200},
        {"symbol": "6682", "date": "2026-05-15", "close": 88},
    ]
    stockvision_rows = [
        {"symbol": "2330", "date": "2026-05-15", "close": 900},
        {"symbol": "2454", "date": "2026-05-15", "close": 1190},
    ]

    report = build_source_diff_report(
        dataset_lane="daily_price",
        finlab_rows=finlab_rows,
        stockvision_rows=stockvision_rows,
        primary_keys=("symbol", "date"),
        compare_fields=("close",),
        generated_at="2026-05-16T00:00:00+00:00",
    )
    fill_rows = build_gap_fill_rows(report)

    assert report["summary"]["matched"] == 1
    assert report["summary"]["missing_in_stockvision"] == 1
    assert report["summary"]["value_conflicts"] == 1
    assert fill_rows == [
        {
            "symbol": "6682",
            "date": "2026-05-15",
            "close": 88,
            "_fill_source": "finlab",
            "_fill_reason": "missing_in_stockvision",
            "_dataset_lane": "daily_price",
            "_lineage": {
                "diff_checksum": report["checksum"],
                "generated_at": "2026-05-16T00:00:00+00:00",
                "conflict_policy": "do_not_fill_value_conflicts",
            },
        }
    ]


def test_run_finlab_backfill_diff_returns_manifest_gap_fill_and_conflict_counts():
    adapter = FakeFinLabAdapter(
        {
            "institutional_investors:foreign_net": [
                {"symbol": "2330", "date": "2026-05-15", "foreign_net": 1000},
                {"symbol": "6682", "date": "2026-05-15", "foreign_net": 120},
            ]
        }
    )

    manifest = run_finlab_backfill_diff(
        adapter=adapter,
        requests=[
            FinLabBackfillRequest(
                api_key="institutional_investors:foreign_net",
                dataset_lane="chip_diversity",
                compare_fields=("foreign_net",),
            )
        ],
        stockvision_rows_by_lane={
            "chip_diversity": [
                {"symbol": "2330", "date": "2026-05-15", "foreign_net": 990},
            ]
        },
        store=FinLabLocalBackfillStore(_workspace_tmp("backfill")),
        run_id="run-2",
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert manifest["summary"] == {
        "dataset_count": 1,
        "finlab_rows": 2,
        "gap_fill_rows": 1,
        "value_conflicts": 1,
        "missing_in_stockvision": 1,
    }
    assert manifest["gap_fill_rows"][0]["symbol"] == "6682"
    assert manifest["datasets"][0]["clean_path"]
    assert Path(manifest["datasets"][0]["clean_path"]).exists()

    run_row = finlab_backfill_run_d1_row(manifest)
    diff_rows = source_diff_report_d1_rows(manifest)
    assert run_row["run_id"] == "run-2"
    assert run_row["dataset_count"] == 1
    assert run_row["gap_fill_rows"] == 1
    assert diff_rows[0]["dataset_lane"] == "chip_diversity"
    assert diff_rows[0]["value_conflicts"] == 1
    assert "report_json" in diff_rows[0]
