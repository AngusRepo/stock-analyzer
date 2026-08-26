from __future__ import annotations

import json

from graphs import daily_pipeline_v2 as pipeline


def test_shadow_suppressions_are_deterministic_bounded_audit_receipt() -> None:
    rows = [
        {
            "model_name": f"Model-{index % 8}",
            "artifact_id": f"artifact-{index}-" + "x" * 300,
            "reason": f"invalid candidate {index}: " + "y" * 500,
        }
        for index in range(500)
    ]

    first = pipeline._pipeline_modal_compact_shadow_suppressions(rows)
    second = pipeline._pipeline_modal_compact_shadow_suppressions(list(reversed(rows)))

    assert first == second
    assert first[0] == {
        "schema_version": "active8-shadow-suppression-summary-v1",
        "total_count": 500,
        "sample_count": 32,
        "omitted_count": 468,
        "full_evidence_owner": "model_artifact_registry",
    }
    assert len(first) == 33
    assert len(json.dumps(first, sort_keys=True).encode("utf-8")) < 65_536


def test_empty_suppressions_still_carry_explicit_zero_summary() -> None:
    assert pipeline._pipeline_modal_compact_shadow_suppressions([]) == [{
        "schema_version": "active8-shadow-suppression-summary-v1",
        "total_count": 0,
        "sample_count": 0,
        "omitted_count": 0,
        "full_evidence_owner": "model_artifact_registry",
    }]
