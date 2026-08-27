import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graphs import daily_pipeline_v2 as pipeline  # noqa: E402


def _authority() -> dict:
    return {
        "schema_version": pipeline.ACTIVE8_ACTION_AUTHORITY_SCHEMA,
        "mode": pipeline.ACTIVE8_ACTION_MODE_EVIDENCE_ONLY,
        "buy_authorized": False,
        "production_effect": False,
        "reason": "no_promoted_active8_ensemble_pointer",
    }


def test_frozen_manifest_resolver_accepts_digest_bound_context() -> None:
    manifest = {
        "schema_version": pipeline.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
        "active8_action_authority": _authority(),
    }
    state = {
        "pipeline_modal_serving_context": {
            "schema_version": "pipeline-modal-serving-context-v1",
            "serving_manifest": manifest,
            "serving_manifest_digest": pipeline._pipeline_modal_canonical_digest(manifest),
        }
    }

    assert pipeline._pipeline_frozen_serving_manifest(state) == manifest


def test_frozen_manifest_resolver_rejects_top_level_legacy_manifest() -> None:
    state = {
        "serving_manifest": {
            "schema_version": pipeline.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
            "active8_action_authority": _authority(),
        }
    }

    with pytest.raises(RuntimeError, match="pipeline_modal_serving_context:missing"):
        pipeline._pipeline_frozen_serving_manifest(state)


def test_frozen_manifest_resolver_rejects_digest_drift() -> None:
    manifest = {
        "schema_version": pipeline.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
        "active8_action_authority": _authority(),
    }
    state = {
        "pipeline_modal_serving_context": {
            "schema_version": "pipeline-modal-serving-context-v1",
            "serving_manifest": manifest,
            "serving_manifest_digest": "0" * 64,
        }
    }

    with pytest.raises(
        RuntimeError,
        match="pipeline_modal_serving_context:serving_manifest_invalid",
    ):
        pipeline._pipeline_frozen_serving_manifest(state)
