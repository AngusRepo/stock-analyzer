import numpy as np
import pytest

from services.r33_isotonic_calibration import MODELS, build_payload, expected_excess, pava, pool_scores, predict, validate_payload


def _pool(n=6):
    ranks = np.tile(np.arange(n, dtype=float)[:, None], (1, len(MODELS)))
    return ranks, np.ones(ranks.shape, dtype=bool)


def test_unavailable_model_contributes_zero_and_denominator_stays_seven():
    ranks, available = _pool()
    available[:, 0] = False
    score, z, uninformative = pool_scores(ranks, available, variant="mean_z")
    assert (z[:, 0] == 0).all() and uninformative == []
    assert np.allclose(score, z[:, 1:].sum(axis=1) / 7)


def test_rank_is_reranked_among_available_pool_stocks_only():
    ranks, available = _pool()
    available[0, 2] = False
    ranks[0, 2] = 1e9  # an unavailable value must not move anyone's position
    _, z, _ = pool_scores(ranks, available, variant="mean_z")
    expected = np.arange(1, 6, dtype=float)
    assert np.allclose(z[1:, 2], (expected - expected.mean()) / expected.std()) and z[0, 2] == 0


def test_model_without_dispersion_is_uninformative_not_fatal():
    ranks, available = _pool()
    ranks[:, 3] = 0.4
    _, z, uninformative = pool_scores(ranks, available, variant="mean_z")
    assert uninformative == ["GNN"] and (z[:, 3] == 0).all()


def test_restandardized_variant_has_unit_dispersion_and_same_order():
    rng = np.random.default_rng(7)
    ranks = rng.random((40, len(MODELS)))
    available = rng.random(ranks.shape) > 0.2
    raw, _, _ = pool_scores(ranks, available, variant="mean_z")
    rescaled, _, _ = pool_scores(ranks, available, variant="mean_z_restandardized")
    assert np.isclose(rescaled.std(), 1.0) and np.isclose(rescaled.mean(), 0.0)
    assert (np.argsort(raw, kind="stable") == np.argsort(rescaled, kind="stable")).all()


def test_flat_pool_fails_closed_when_restandardizing():
    ranks, available = _pool()
    ranks[:] = 1.0
    with pytest.raises(ValueError, match="r33_pool_no_score_dispersion"):
        pool_scores(ranks, available, variant="mean_z_restandardized")


def test_pava_is_monotone_weighted_and_merges_equal_scores():
    blocks = pava([0, 1, 1, 2, 3], [0.3, -0.1, 0.1, 0.0, 0.5], [1, 1, 1, 2, 1])
    means = [b["mean_excess"] for b in blocks]
    assert means == sorted(means)
    assert all(b["score_lo"] <= b["score_hi"] for b in blocks)
    assert sum(b["n"] for b in blocks) == 5
    assert np.isclose(sum(b["mean_excess"] * b["weight"] for b in blocks), 0.3 - 0.1 + 0.1 + 0.0 + 0.5)


def test_predict_is_a_step_lookup_clipped_at_both_ends():
    blocks = pava([0, 1, 2], [0.0, 1.0, 2.0], [1, 1, 1])
    assert list(predict(blocks, [-5, 0.5, 1.0, 9])) == [0.0, 0.0, 1.0, 2.0]


def _payload():
    blocks = pava([0, 1, 2], [0.0, 0.01, 0.02], [1, 1, 1])
    return build_payload(blocks=blocks, variant="mean_z", horizon_sessions=5, inputs={"oof": "x"}, diagnostics={})


def test_payload_round_trips_and_rejects_tampering():
    payload = _payload()
    assert validate_payload(payload) is payload
    assert list(expected_excess(payload, [1.5])) == [0.01]
    tampered = dict(payload, blocks=[dict(b) for b in payload["blocks"]])
    tampered["blocks"][-1]["mean_excess"] = 0.5
    with pytest.raises(ValueError, match="checksum"):
        validate_payload(tampered)


def test_payload_rejects_unknown_variant():
    with pytest.raises(ValueError, match="r33_score_variant_unknown"):
        pool_scores(*_pool(), variant="mean_rank")


def test_min_block_weight_merges_thin_tail_blocks_and_stays_monotone():
    x = np.arange(10, dtype=float)
    y = np.r_[np.zeros(9), 5.0]
    w = np.ones(10)
    assert pava(x, y, w)[-1]["n"] == 1
    blocks = pava(x, y, w, min_block_weight=3)
    assert min(b["weight"] for b in blocks) >= 3 and sum(b["n"] for b in blocks) == 10
    means = [b["mean_excess"] for b in blocks]
    assert means == sorted(means)
    assert np.isclose(sum(b["mean_excess"] * b["weight"] for b in blocks), y.sum())
