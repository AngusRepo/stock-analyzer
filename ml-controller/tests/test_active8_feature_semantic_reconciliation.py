import os
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))
os.environ.setdefault("STOCKVISION_SOURCE_SHA", "0123456789abcdef0123456789abcdef01234567")


def _manifest():
    from routers import walk_forward

    return {
        "schema_version": "active8-oof-cohort-manifest-v5",
        "cohort_id": "cohort-v9",
        "manifest_checksum": "a" * 64,
        "prep_manifest": {
            "feature_semantic_version": walk_forward.OOF_FEATURE_SEMANTIC_VERSION,
            "feature_imputation_semantic": walk_forward.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION,
            "manifest_checksum": "b" * 64,
            "producer_source_sha": "c" * 40,
        },
    }


def _metadata():
    return {
        "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "model_training_config_attestation": {
            "dataset_snapshot_schema_version": "active8-oof-full-fit-prep-lineage-v2",
            "dataset_snapshot_id": f"oof_full_fit:cohort-v9:{'a' * 64}",
            "input_lineage": {
                "source_cohort_id": "cohort-v9",
                "source_manifest_checksum": "a" * 64,
                "prep_manifest_checksum": "b" * 64,
                "prep_producer_source_sha": "c" * 40,
            },
            "model_spec": {
                "family": "tabular_neural",
                "feature_schema": "formal137_selected_tabular_v1",
                "trainer": "tabm_artifact",
            },
        },
    }


def test_tabm_semantic_reconciliation_requires_exact_immutable_snapshot_binding():
    from routers import walk_forward

    result = walk_forward._reconcile_tabm_oof_feature_semantic_metadata(
        _metadata(),
        manifest=_manifest(),
    )

    assert result["feature_semantic_version"] == walk_forward.OOF_FEATURE_SEMANTIC_VERSION
    assert result["feature_imputation_semantic"] == walk_forward.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION
    assert result["feature_semantic_attestation"] == {
        "schema_version": "active8-oof-feature-semantic-attestation-v1",
        "source": "immutable_oof_snapshot_binding",
        "cohort_id": "cohort-v9",
        "source_manifest_checksum": "a" * 64,
        "prep_manifest_checksum": "b" * 64,
        "prep_producer_source_sha": "c" * 40,
    }


def test_tabm_semantic_reconciliation_rejects_snapshot_checksum_mismatch():
    from routers import walk_forward

    metadata = _metadata()
    metadata["model_training_config_attestation"]["input_lineage"]["prep_manifest_checksum"] = "d" * 64
    with pytest.raises(RuntimeError, match="feature_semantic_attestation_invalid"):
        walk_forward._reconcile_tabm_oof_feature_semantic_metadata(
            metadata,
            manifest=_manifest(),
        )


def test_terminal_validation_reconciles_missing_tabm_alias_once(monkeypatch):
    import asyncio
    import json
    from routers import walk_forward

    receipt = {
        "schema_version": "active8-oof-full-fit-receipt-v1",
        "status": "blocked",
        "reason": "active8_ensemble_validation_failed",
        "cohort_id": "cohort-v9",
        "knowledge_cutoff_date": "2026-08-27",
        "run_id": "universal-oof-owner",
        "release_models": ["TabM"],
        "promotion_eligible_models": ["TabM"],
        "missing_models": [],
        "training_failed_models": [],
        "retry_required": False,
        "release_registry": {
            "status": "blocked",
            "reason": "active8_ensemble_validation_failed",
            "retry_required": False,
            "validation_schema_version": "active8-oof-ensemble-validation-v1",
            "validation": {
                "schema_version": "active8-oof-ensemble-validation-v1",
                "decision": "FAIL",
                "failed_gates": ["rank_ic_lcb90_non_positive"],
            },
        },
    }
    uploads = []

    class Blob:
        def exists(self):
            return True

        def download_as_text(self):
            return json.dumps(receipt)

        def upload_from_string(self, value, content_type=None):
            uploads.append((json.loads(value), content_type))

    class Bucket:
        def blob(self, path):
            assert path == "walk_forward/oof_cohorts/cohort-v9/full_fit/2026-08-27.json"
            return Blob()

    plan = {
        "status": "ready",
        "release_models": ["TabM"],
        "promotion_eligible_models": ["TabM"],
        "tree_models": [],
        "feature_consensus": {},
        "train_model_groups": ["tabm"],
        "artifact_lifecycle_targets": [],
        "promotion_evidence": {"TabM": {"decision": "PASS"}},
    }
    row = {
        "model_name": "TabM",
        "offline_evidence_json": json.dumps({"registration": {"metadata": {}}}),
    }
    reconciled_registry = {
        **receipt["release_registry"],
        "validation": dict(receipt["release_registry"]["validation"]),
        "validation_attempt": {
            "status": "persisted",
            "attempt_id": "attempt-tabm-v1",
            "validation_decision": "FAIL",
            "production_effect": False,
        },
    }
    calls = []
    monkeypatch.setattr(walk_forward, "build_oof_full_fit_dispatch_plan", lambda _manifest: plan)
    monkeypatch.setattr(walk_forward.LEARNING_D1_CLIENT, "query", lambda *_args, **_kwargs: [row])
    monkeypatch.setattr(
        walk_forward,
        "_select_oof_full_fit_source_rows",
        lambda _rows, _models: {"TabM": row},
    )
    monkeypatch.setattr(
        walk_forward,
        "_materialize_completed_oof_release_aliases",
        lambda **kwargs: calls.append(kwargs) or reconciled_registry,
    )

    result = asyncio.run(
        walk_forward.dispatch_oof_full_fit_training(
            manifest={"cohort_id": "cohort-v9", "manifest_checksum": "a" * 64},
            knowledge_cutoff_date="2026-08-27",
            bucket=Bucket(),
            lifecycle_cadence="monthly",
            allow_new_dispatch=False,
        )
    )

    assert len(calls) == 1
    assert result["status"] == "blocked"
    assert result["semantic_reconciliation"]["status"] == "complete"
    assert uploads[0][0]["semantic_reconciliation"]["source"] == "immutable_oof_snapshot_binding"
