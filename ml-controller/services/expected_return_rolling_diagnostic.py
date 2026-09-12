"""Daily diagnostic refits. Never register or return a promotion candidate."""
from __future__ import annotations

from typing import Any, Callable


def build_rolling_diagnostics(
    *, snapshot_rows: list[dict[str, Any]], l4_predictions: list[dict[str, Any]],
    cohort_id: str, knowledge_cutoff_date: str, extension_dates: list[str],
    build_fusion_rows: Callable[..., list[dict[str, Any]]], query_fn: Callable,
) -> dict[str, dict[str, Any]]:
    from services.l4_alpha_ev_artifact_builder import build_l4_alpha_ev_artifact_from_rows
    from services.allocator_ev_fusion_artifact_builder import build_allocator_ev_fusion_artifact_from_rows

    available_dates = sorted({str(row["snapshot_date"])[:10] for row in snapshot_rows})
    if not available_dates or not set(extension_dates).intersection(available_dates):
        raise ValueError("rolling_diagnostic_forward_population_missing")
    kwargs = dict(
        trained_until=available_dates[-1], generation_mode="purged_oof",
        cohort_id=cohort_id, artifact_generated_at=f"{knowledge_cutoff_date}T00:00:00+00:00",
    )
    # Keep this result separate from the immutable base-candidate path. The
    # existing builders retain their purged temporal split and walk-forward.
    l4 = build_l4_alpha_ev_artifact_from_rows(snapshot_rows, **kwargs)
    fusion_rows = build_fusion_rows(
        snapshot_rows, l4_predictions, knowledge_cutoff_date=knowledge_cutoff_date,
        query_fn=query_fn,
    )
    fusion = build_allocator_ev_fusion_artifact_from_rows(
        fusion_rows, knowledge_cutoff_date=knowledge_cutoff_date, **kwargs,
    )
    results = {"l4_alpha_ev": l4, "allocator_ev_fusion": fusion}
    for name, result in results.items():
        packet = result["validation_packet"]
        audit = packet["sample_audit"]
        metrics = (packet.get("oos_metrics") or {}) if name == "l4_alpha_ev" else (
            packet.get("residual_adjustment_model", {}).get("oos_metrics") or {}
        )
        packet["diagnostic_population"] = {
            "schema_version": "expected-return-rolling-population-v1",
            "method": "purged_temporal_refit_diagnostic_only",
            "available_dates": available_dates,
            "extension_dates": sorted(set(extension_dates)),
            "usable_min_date": audit.get("evidence_min_date"),
            "usable_max_date": audit.get("evidence_max_date"),
            "evaluated_dates": metrics.get("evaluated_dates", []),
            "promotion_eligible": False,
        }
        packet["monitoring_policy"] = {
            "policy_decision": "shadow_only", "promotion_eligible": False,
            "formal_training_dispatched": False,
        }
        result["artifact"]["promotion_state"] = "shadow_only"
    return results
