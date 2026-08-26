from pathlib import Path


SOURCE = ""


def _retired_historical_variant_source_uses_requested_run_date() -> None:
    assert "persisted_2026-07-09_daily_recommendations" not in SOURCE
    assert 'f"persisted_{run_date}_daily_recommendations"' in SOURCE
    assert "_historical_actual_variant(rows, run_date=args.run_date)" in SOURCE


def _retired_local_parity_defaults_to_frozen_upstream_and_keeps_guarded_fusion_unforced() -> None:
    assert 'choices=("frozen", "current-reensemble"), default="frozen"' in SOURCE
    assert '"source": "frozen_same_run_ensemble_v2"' in SOURCE
    assert 'guarded_fusion_policy["allocator_ev_fusion"] = fusion_shadow' in SOURCE
    assert '_run_variant("fusion_v11_guarded"' in SOURCE
    assert '"frozen_lineage_audit": frozen_lineage_audit' in SOURCE


def _retired_local_parity_reconstructs_l4_lineage_before_building_artifact() -> None:
    reconstruct = SOURCE.index("l4_lineage_training, l4_lineage_audit = reconstruct_rows_with_point_in_time_lineage(")
    build = SOURCE.index("l4_result = build_l4_alpha_ev_artifact_from_rows(")

    assert reconstruct < build
    assert "l4_lineage_training," in SOURCE[build:build + 200]
    assert '"lineage_reconstruction": l4_lineage_audit' in SOURCE
    assert '"closure_audit": _closure_audit(' in SOURCE
    assert '"next_session_evidence_role": "event_time_audit_only_not_feature_or_label"' in SOURCE
    assert "opb_counterfactual_rows, opb_price_rows = load_opb_counterfactual_inputs(" in SOURCE
    assert 'for owner in ("l4_alpha_ev", "allocator_ev_fusion"):' in SOURCE
    assert '"opb_counterfactual_priors": opb_prior_results' in SOURCE
    assert "snapshot_dry_run = build_allocator_ev_feature_snapshots_for_date(" in SOURCE
    assert '"native_snapshot_closed": native_snapshot_closed' in SOURCE
