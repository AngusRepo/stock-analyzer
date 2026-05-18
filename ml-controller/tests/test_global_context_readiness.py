from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.global_context_readiness import (  # noqa: E402
    REQUIRED_US_LEADING_FIELDS,
    build_global_context_readiness_report,
    select_morning_context_source,
    validate_global_context_readiness_report,
)


def _catalog() -> dict:
    fields = [
        {
            "api_key": "world_index:close",
            "market": "tw",
            "namespace": "world_index",
            "field": "close",
            "dataset_lane": "global_context",
            "adoption_priority": "P0",
            "adoption_mode": "augment",
            "quality_gate": "coverage, delay, holiday_calendar_alignment",
        },
        {
            "api_key": "world_index:open",
            "market": "tw",
            "namespace": "world_index",
            "field": "open",
            "dataset_lane": "global_context",
            "adoption_priority": "P0",
            "adoption_mode": "augment",
            "quality_gate": "coverage, delay, holiday_calendar_alignment",
        },
        {
            "api_key": "us_market_signals:vix_close",
            "market": "us",
            "namespace": "us_market_signals",
            "field": "vix_close",
            "dataset_lane": "global_context",
            "adoption_priority": "P1",
            "adoption_mode": "augment",
            "quality_gate": "coverage, delay, license, survivorship_check",
        },
    ]
    return {"schema_version": "finlab-api-field-catalog-v1", "fields": fields}


def test_world_index_can_augment_morning_setup_but_cannot_replace_us_leading():
    report = build_global_context_readiness_report(
        _catalog(),
        observed_sources=[
            {
                "source_id": "finlab_world_index",
                "source_kind": "world_index",
                "provided_fields": ["world_index:close", "world_index:open"],
                "coverage_ratio": 0.99,
                "max_delay_days": 1,
                "license_status": "allowed",
                "holiday_alignment": "verified",
            }
        ],
        generated_at="2026-05-16T00:00:00+00:00",
    )

    world = report["evaluations"][0]

    assert world["status"] == "augment_candidate"
    assert world["allowed_use"] == "augment_morning_setup"
    assert world["replacement_surface"] == "global_context"
    assert world["checks"]["license"]["passed"] is True
    assert select_morning_context_source(report)["source_id"] == "stockvision_worker_us_leading"
    assert validate_global_context_readiness_report(report) == []


def test_us_global_source_replaces_current_us_leading_only_after_all_gates_pass():
    report = build_global_context_readiness_report(
        _catalog(),
        observed_sources=[
            {
                "source_id": "finlab_us_leading",
                "source_kind": "us_leading",
                "provided_fields": sorted(REQUIRED_US_LEADING_FIELDS),
                "coverage_ratio": 0.98,
                "max_delay_days": 1,
                "license_status": "allowed",
                "survivorship_check": "passed",
            }
        ],
        generated_at="2026-05-16T00:00:00+00:00",
    )

    candidate = report["evaluations"][0]

    assert candidate["status"] == "replacement_candidate"
    assert candidate["allowed_use"] == "replace_current_us_leading"
    assert candidate["replacement_surface"] == "us_leading"
    assert candidate["checks"]["required_fields"]["passed"] is True
    assert select_morning_context_source(report)["source_id"] == "finlab_us_leading"
    assert validate_global_context_readiness_report(report) == []


def test_license_pending_keeps_finlab_us_context_shadow_only_even_with_good_coverage():
    report = build_global_context_readiness_report(
        _catalog(),
        observed_sources=[
            {
                "source_id": "finlab_us_leading",
                "source_kind": "us_leading",
                "provided_fields": sorted(REQUIRED_US_LEADING_FIELDS),
                "coverage_ratio": 0.99,
                "max_delay_days": 0,
                "license_status": "unknown",
                "survivorship_check": "passed",
            }
        ],
        generated_at="2026-05-16T00:00:00+00:00",
    )

    candidate = report["evaluations"][0]

    assert candidate["status"] == "shadow_only"
    assert candidate["allowed_use"] == "shadow_context"
    assert candidate["checks"]["license"]["passed"] is False
    assert "license_not_allowed" in candidate["blocking_reasons"]
    assert select_morning_context_source(report)["source_id"] == "stockvision_worker_us_leading"


def test_readiness_report_summarizes_finlab_global_catalog_surface():
    report = build_global_context_readiness_report(
        _catalog(),
        observed_sources=[],
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert report["catalog_summary"]["world_index_fields"] == 2
    assert report["catalog_summary"]["us_fields"] == 1
    assert report["policy"]["replacement_gate"] == "coverage_delay_license_required_fields"
