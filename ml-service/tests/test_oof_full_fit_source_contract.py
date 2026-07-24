from __future__ import annotations

from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent


def test_full_fit_tree_candidate_save_accepts_immutable_prep_prefix():
    source = (ROOT / "app" / "universal_training.py").read_text(encoding="utf-8")

    assert "if req.output_model_version:" in source
    assert '"status": "shadow_source" if walk_forward_mode else "registered"' in source
    assert 'f"{gcs_prefix}/frozen_models"' in source
    assert (
        "if req.output_model_version and not walk_forward_mode "
        'and gcs_prefix == "universal":'
    ) not in source


def test_sequence_full_fit_uses_canonical_model_seq_len():
    source = (ROOT / "modal_app.py").read_text(encoding="utf-8")

    assert "default_seq_len_for_model(model_name)" in source
    assert 'if model_name == "iTransformer":\n                    return 1024' not in source


def test_tree_child_failures_are_preserved_in_followup_evidence():
    source = (ROOT / "modal_app.py").read_text(encoding="utf-8")

    assert '"child_errors": tree_result.get("child_errors") or []' in source


def test_oof_date_cluster_evidence_uses_initialized_prep_bucket():
    source = (ROOT / "modal_app.py").read_text(encoding="utf-8")

    assert "raw = prep_bucket.blob(path).download_as_bytes()" in source
    assert "raw = bucket.blob(path).download_as_bytes()" not in source


def test_frozen_forward_requires_exact_shadow_tree_artifact():
    from app.oof_forward_extension import _tree_source_artifact

    with pytest.raises(
        ValueError,
        match="forward_extension_exact_tree_artifact_missing:LightGBM",
    ):
        _tree_source_artifact({"tree_result": {"artifact_registrations": {}}}, "LightGBM")


def test_frozen_forward_accepts_checksum_bound_shadow_tree_artifact():
    from app.oof_forward_extension import _tree_source_artifact

    source = {
        "status": "shadow_source",
        "promotion_eligible": False,
        "gcs_path": "walk_forward/frozen/lightgbm/v1.joblib",
        "metadata_path": "walk_forward/frozen/lightgbm/metadata_v1.json",
        "checksum": "sha256:abc",
    }
    assert _tree_source_artifact(
        {"tree_result": {"artifact_registrations": {"LightGBM": source}}},
        "LightGBM",
    ) == source
