from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_full_fit_tree_candidate_save_accepts_immutable_prep_prefix():
    source = (ROOT / "app" / "universal_training.py").read_text(encoding="utf-8")

    assert "if req.output_model_version and not walk_forward_mode:" in source
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
