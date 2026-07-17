from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


def _payload() -> dict:
    checksum = "a" * 64
    return {
        "schema_version": "l4-alpha-ev-v1",
        "artifact_contract_version": "l4-alpha-ev-contract-v4",
        "feature_snapshot_version": "l4-directional-score-components-v2-lineage-bound",
        "label_schema_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "approval_state": "purged_oof_evidence_only",
        "purged_oof_evidence_only": True,
        "expected_return_owner": "l4_alpha_ev",
        "expected_return_source": "l4_purged_oof_chronological_cross_fit",
        "expected_return": 0.012,
        "trained_until": "2026-06-24",
        "model_version": "l4-oof-test",
        "resolver_method": "ridge_chronological_cross_fit",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
        "generation_mode": "purged_oof",
        "cohort_id": "cohort-v3",
        "fold_id": "w2",
        "source_manifest_checksum": checksum,
        "point_in_time_prediction_lineage": {
            "schema_version": "l4-point-in-time-prediction-lineage-v1",
            "as_of_guard": "label_known_date_strictly_before_prediction_date",
            "cohort_id": "cohort-v3",
            "fold_id": "w2",
            "prediction_date": "2026-06-25",
            "trained_until": "2026-06-24",
            "source_manifest_checksum": checksum,
            "feature_semantic_version": "l4-directional-score-components-v2-lineage-bound",
        },
    }


def test_purged_oof_payload_is_evidence_eligible_but_never_production_eligible():
    from services.l4_alpha_ev_resolver import PURGED_OOF_USAGE_SCOPE, resolve_l4_alpha_ev

    evidence = resolve_l4_alpha_ev(_payload(), usage_scope=PURGED_OOF_USAGE_SCOPE)
    production = resolve_l4_alpha_ev(_payload(), usage_scope="production")

    assert evidence["status"] == "loaded"
    assert evidence["purged_oof_evidence_eligible"] is True
    assert evidence["production_eligible"] is False
    assert production["status"] == "rejected"
    assert production["expected_return"] is None


def test_purged_oof_payload_fails_closed_on_semantic_checksum_or_time_drift():
    from services.l4_alpha_ev_resolver import PURGED_OOF_USAGE_SCOPE, resolve_l4_alpha_ev

    for mutate in (
        lambda payload: payload.update(feature_snapshot_version="legacy-feature"),
        lambda payload: payload.update(source_manifest_checksum="short"),
        lambda payload: payload.update(trained_until="2026-06-25"),
    ):
        payload = _payload()
        mutate(payload)
        resolved = resolve_l4_alpha_ev(payload, usage_scope=PURGED_OOF_USAGE_SCOPE)
        assert resolved["status"] == "rejected"
        assert resolved["expected_return"] is None
        assert resolved["purged_oof_evidence_eligible"] is False
