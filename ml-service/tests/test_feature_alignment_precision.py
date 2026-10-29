import numpy as np
import pytest
from app.batch_prediction import _FeatureBatchContext, _align_latest_features


def test_feature_subset_alignment_preserves_tree_split_side():
    threshold = 1.00000003
    value = 1.00000004
    assert np.float32(value) < threshold < value
    context = _FeatureBatchContext(req=None, x_latest=np.array([[99., value]], dtype=np.float64),
                                   feature_names=['unused', 'edge'])
    aligned = _align_latest_features(context, {
        'feature_names': ['edge'], 'feature_medians': {'edge': 0.}})
    assert aligned.dtype == np.float64
    assert aligned[0, 0] == value
    assert aligned[0, 0] > threshold


def test_float32_neural_inputs_keep_their_existing_precision():
    context = _FeatureBatchContext(req=None, x_latest=np.array([[.2, .7]], dtype=np.float32),
                                   feature_names=['first', 'second'])
    aligned = _align_latest_features(context, {
        'feature_names': ['second'], 'feature_medians': {'second': 0.}})
    assert aligned.dtype == np.float32
    assert aligned[0, 0] == context.x_latest[0, 1]


@pytest.mark.parametrize("selected", [["edge"], ["unused", "edge"]])
def test_frozen_oof_extension_preserves_precision_with_and_without_fs(selected):
    from app.oof_forward_extension import _align_features
    value = 1.00000004
    matrix = np.array([[99., value]], dtype=np.float64)
    aligned = _align_features(matrix, ["unused", "edge"], {
        "feature_names": selected, "feature_medians": {"unused": 0., "edge": 0.}})
    assert aligned.dtype == np.float64
    assert aligned[0, -1] == value and aligned[0, -1] > 1.00000003


def test_frozen_oof_extension_refuses_an_artifact_bound_to_another_contract():
    from app.oof_forward_extension import _align_features
    matrix = np.ones((2, 2), dtype=np.float32)
    bound = {"feature_names": ["a", "b"], "input_scope": {"pit_contract_version": "pit-availability-contract-v1"}}
    assert _align_features(matrix, ["a", "b"], bound, pit_contract_version="pit-availability-contract-v1").shape == (2, 2)
    assert _align_features(matrix, ["a", "b"], {"feature_names": ["a", "b"]},
                           pit_contract_version="pit-availability-contract-v1").shape == (2, 2)
    with pytest.raises(ValueError, match="forward_extension_pit_contract_mismatch"):
        _align_features(matrix, ["a", "b"], bound, pit_contract_version=None)


@pytest.mark.parametrize("base_version, forward_version, allowed", [
    (None, None, True), ("pit-availability-contract-v1", "pit-availability-contract-v1", True),
    ("pit-availability-contract-v1", None, False), (None, "pit-availability-contract-v1", False)])
def test_frozen_oof_extension_rows_carry_the_cohort_prep_contract(monkeypatch, base_version, forward_version, allowed):
    from app import alpha_model_roster, oof_forward_extension as ext
    # The checksum-verified cohort manifest records the contract its prep was built under.
    base_prep = {"manifest_checksum": "a" * 64, **({"pit_contract_version": base_version} if base_version else {})}
    monkeypatch.setattr(ext, "_get_bucket", lambda: object())
    monkeypatch.setattr(ext, "_verify_base_manifest", lambda bucket, path: {"prep_manifest": base_prep, "model_set": []})
    monkeypatch.setattr(ext, "cohort_semantic", lambda base: "semantic")
    monkeypatch.setattr(ext, "_verify_prep_manifest", lambda bucket, prefix, semantic: {
        "output_gcs_prefix": prefix, **({"pit_contract_version": forward_version} if forward_version else {})})

    def reached(*a, **k):
        raise LookupError("reached")
    monkeypatch.setattr(alpha_model_roster, "model_order", reached)
    payload = {"base_manifest_path": "m.json", "prep_gcs_prefix": "fwd", "sequence_gcs_prefix": "seq",
               "sequence_batch_count": 1, "start_date": "2026-10-01", "end_date": "2026-10-02",
               "knowledge_cutoff_date": "2026-10-09"}
    with pytest.raises(LookupError if allowed else ValueError,
                       match="reached" if allowed else "forward_extension_pit_contract_mismatch"):
        ext.build_frozen_forward_extension(payload)
