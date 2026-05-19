from __future__ import annotations

import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_dagster_runtime import (  # noqa: E402
    build_runtime_requests_from_adoption_plan,
    run_finlab_dagster_local_materialization,
)


ROOT = Path(__file__).resolve().parents[2]


def _workspace_tmp(name: str) -> Path:
    path = ROOT / ".tmp" / "v4_1_runtime_tests" / f"{name}-{uuid4().hex}"
    path.mkdir(parents=True, exist_ok=True)
    return path


class FakeFinLabAdapter:
    def get_dataset(self, api_key: str):
        return [
            {"symbol": "2330", "date": "2026-05-15", "value": 900, "name": "TSMC", "market": "sii"},
            {"symbol": "6682", "date": "2026-05-15", "value": 88, "name": "Emerging", "market": "rotc"},
        ]


def _adoption_plan():
    return {
        "assets": [
            {
                "stage": "parity",
                "dataset_lane": "daily_price",
                "markets": ["tw"],
                "sample_api_keys": ["price:close", "price:volume", "price:open"],
            },
            {
                "stage": "diversity",
                "dataset_lane": "emerging_chip_diversity",
                "markets": ["tw"],
                "sample_api_keys": ["rotc_broker_transactions"],
            },
            {
                "stage": "research",
                "dataset_lane": "research",
                "markets": ["tw"],
                "sample_api_keys": ["research_only"],
            },
        ]
    }


def test_build_runtime_requests_uses_parity_and_diversity_sample_keys():
    requests = build_runtime_requests_from_adoption_plan(_adoption_plan(), max_api_keys_per_lane=2)

    assert [request.api_key for request in requests] == [
        "price:close",
        "price:volume",
        "rotc_broker_transactions",
    ]
    assert requests[0].dataset_lane == "daily_price"
    assert requests[-1].dataset_lane == "emerging_chip_diversity"


def test_run_finlab_dagster_local_materialization_writes_backfill_manifest():
    output_dir = _workspace_tmp("dagster")
    manifest = run_finlab_dagster_local_materialization(
        adapter=FakeFinLabAdapter(),
        adoption_plan=_adoption_plan(),
        stockvision_rows_by_lane={"daily_price": [{"symbol": "2330", "date": "2026-05-15", "value": 900}]},
        output_dir=str(output_dir),
        run_id="dagster-local",
        generated_at="2026-05-16T00:00:00+00:00",
        max_api_keys_per_lane=1,
    )

    assert manifest["dagster_runtime"]["mode"] == "local_materialization"
    assert manifest["dagster_runtime"]["schedule_ready"] is True
    assert manifest["dagster_runtime"]["prod_schedule_enabled"] is False
    assert manifest["summary"]["dataset_count"] == 2
    assert (output_dir / "dagster-local" / "manifest.json").exists()
