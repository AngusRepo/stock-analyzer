from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-service"))

from app.oof_manifest_publisher import prepare_oof_manifest_publication  # noqa: E402


def _manifest(*, reused: bool = True, mean_ic: float = 0.02) -> dict:
    return {
        "schema_version": "active8-oof-cohort-manifest-v3",
        "cohort_id": "active8-oof-v5-test",
        "generation_mode": "purged_oof",
        "status": "ready",
        "model_set": ["LightGBM"],
        "windows": [
            {
                "window_id": 0,
                "reused_from_parent": reused,
                "source_cohort_id": "active8-oof-v5-test",
                "source_fold_id": "w0",
                "model_metrics": {"LightGBM": {"oos_ic": mean_ic}},
            }
        ],
        "aggregate": {
            "cohort_id": "active8-oof-v5-test",
            "new_folds": 0 if reused else 1,
            "reused_folds": 1 if reused else 0,
            "mean_ic": mean_ic,
        },
    }


def test_new_manifest_keeps_base_identity() -> None:
    plan = prepare_oof_manifest_publication(_manifest())
    assert plan["publication_mode"] == "new_cohort"
    assert plan["manifest"]["cohort_id"] == "active8-oof-v5-test"
    assert len(plan["manifest"]["manifest_checksum"]) == 64


def test_same_manifest_is_idempotent() -> None:
    first = prepare_oof_manifest_publication(_manifest())
    second = prepare_oof_manifest_publication(
        _manifest(), existing_manifest=copy.deepcopy(first["manifest"])
    )
    assert second["publication_mode"] == "idempotent_existing"
    assert second["write_required"] is False


def test_evidence_change_creates_content_addressed_revision() -> None:
    existing = prepare_oof_manifest_publication(_manifest(mean_ic=0.01))["manifest"]
    plan = prepare_oof_manifest_publication(
        _manifest(mean_ic=0.03), existing_manifest=existing
    )
    assert plan["publication_mode"] == "immutable_evidence_revision"
    assert plan["manifest"]["cohort_id"].startswith("active8-oof-v5-test-e")
    assert plan["manifest"]["parent_manifest"]["checksum"] == existing["manifest_checksum"]
    assert plan["manifest"]["windows"][0]["source_cohort_id"] == "active8-oof-v5-test"


def test_new_fold_collision_fails_closed() -> None:
    existing = prepare_oof_manifest_publication(_manifest(mean_ic=0.01))["manifest"]
    with pytest.raises(
        ValueError,
        match="active8_oof_ready_cohort_collision_requires_new_training_cohort_id",
    ):
        prepare_oof_manifest_publication(
            _manifest(reused=False, mean_ic=0.03), existing_manifest=existing
        )
