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
