from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_dagster_factory import build_finlab_definitions_payload  # noqa: E402
from services.finlab_quality_checks import (  # noqa: E402
    evaluate_finlab_check_spec,
    evaluate_finlab_check_specs,
)


def _payload() -> dict:
    graph = {
        "schema_version": "finlab-dagster-asset-graph-v1",
        "generated_at": "2026-05-16T00:00:00+00:00",
        "checksum": "sha256:graph",
        "source_plan_checksum": "sha256:plan",
        "nodes": [
            {
                "asset_key": "finlab/parity/daily_price/raw",
                "layer": "raw",
                "deps": [],
                "group_name": "finlab_v4_parity",
                "stage": "parity",
                "dataset_lane": "daily_price",
                "field_count": 3,
                "markets": ["tw"],
                "namespaces": ["price"],
                "stockvision_use": "daily price parity",
            },
            {
                "asset_key": "finlab/parity/daily_price/clean",
                "layer": "clean",
                "deps": ["finlab/parity/daily_price/raw"],
                "group_name": "finlab_v4_parity",
                "stage": "parity",
                "dataset_lane": "daily_price",
                "field_count": 3,
                "markets": ["tw"],
                "namespaces": ["price"],
                "stockvision_use": "daily price parity",
            },
            {
                "asset_key": "finlab/parity/daily_price/feature_lake",
                "layer": "feature_lake",
                "deps": ["finlab/parity/daily_price/clean"],
                "group_name": "finlab_v4_parity",
                "stage": "parity",
                "dataset_lane": "daily_price",
                "field_count": 3,
                "markets": ["tw"],
                "namespaces": ["price"],
                "stockvision_use": "daily price parity",
            },
        ],
        "checks": [
            {
                "asset_key": "finlab/parity/daily_price/raw",
                "check_name": "field_count_positive",
                "severity": "error",
            },
            {
                "asset_key": "finlab/parity/daily_price/clean",
                "check_name": "null_rate",
                "severity": "error",
            },
            {
                "asset_key": "finlab/parity/daily_price/feature_lake",
                "check_name": "provenance",
                "severity": "error",
            },
        ],
    }
    for node in graph["nodes"]:
        node.update({
            "owner": "stockvision_data_platform",
            "source": "finlab",
            "schema": {"schema_ref": "finlab.daily_price", "field_count": 3},
            "freshness": {"policy": "trading_day_after_close", "max_lag_hours": 30},
            "join_key": ["stock_id", "date"],
            "output_location": "gcs://stockvision-models/finlab_v4/parity/daily_price/",
        })
    return build_finlab_definitions_payload(graph)


def test_evaluate_finlab_check_spec_passes_metadata_checks():
    payload = _payload()
    check = next(check for check in payload["asset_checks"] if check["name"] == "field_count_positive")

    result = evaluate_finlab_check_spec(check, payload)

    assert result.passed is True
    assert result.status == "pass"
    assert result.asset_key == ["finlab", "parity", "daily_price", "raw"]
    assert result.metadata["field_count"] == 3


def test_evaluate_finlab_check_spec_marks_unmaterialized_checks_as_observed_not_failed():
    payload = _payload()
    check = next(check for check in payload["asset_checks"] if check["name"] == "null_rate")

    result = evaluate_finlab_check_spec(check, payload)

    assert result.passed is True
    assert result.status == "observed"
    assert result.metadata["requires_materialized_data"] is True
    assert result.reason == "formal_shadow_waiting_for_materialized_rows"


def test_evaluate_finlab_check_specs_returns_one_result_per_payload_check():
    payload = _payload()

    results = evaluate_finlab_check_specs(payload)

    assert len(results) == 3
    assert {result.check_name for result in results} == {
        "field_count_positive",
        "null_rate",
        "provenance",
    }
