"""Arithmetic checks for research falsification, not inference validation."""
import numpy as np
import pytest

from scripts.probe_nav_lifecycle_variance import paths, probe, variance_estimates


def test_variance_estimators_match_independent_direct_formulas_and_units():
    x = np.array([[1., 4., 2., 3., 8., 4., 5., 7., 3., 6.],
                  [3., 1., 9., 7., 1., 2., 6., 9., 2., 4.]])
    before = x.copy()
    result = variance_estimates(x)
    np.testing.assert_allclose(result['sample_variance'], np.var(x, axis=1, ddof=1))
    batches = np.array([[np.mean(row[i:i+3]) for i in (0, 3, 6)] for row in x])
    np.testing.assert_allclose(result['batch_means'], 3 * np.var(batches, axis=1, ddof=1))
    n, lag = 10, 3
    manual = []
    for row in x:
        centered = row - row.mean()
        cov = [sum(centered[t] * centered[t-k] for t in range(k, n)) / n for k in range(lag+1)]
        manual.append((cov[0] + sum(2*(1-k/(lag+1))*cov[k] for k in range(1, lag+1))) * n/(n-1))
    np.testing.assert_allclose(result['bartlett_hac'], manual)
    for key, values in variance_estimates(x * .01).items():
        np.testing.assert_allclose(values, result[key] * .0001)
    np.testing.assert_array_equal(x, before)


def test_same_seed_paths_and_raw_rare_losses_are_not_clipped():
    first = paths('ar03_null', 3, 20, 47)
    np.testing.assert_array_equal(first, paths('ar03_null', 3, 20, 47))
    rare = paths('rare_loss_null', 50, 250, 48)
    assert rare.min() < -.19 and rare.max() > 0


def test_falsification_never_claims_e_process_or_production_authority():
    result = probe(trials=5, sessions=12, seed=49)
    assert result['synthetic_only'] is True
    assert result['production_eligible'] is False and result['is_e_process'] is False
    assert result['first_look_sensitivities'] == [10]
    assert result['hypothesis_alpha'] == pytest.approx(.025)


@pytest.mark.parametrize('args', [{'trials': True}, {'sessions': True}, {'trials': 0}, {'sessions': 9}])
def test_invalid_probe_size(args):
    with pytest.raises(ValueError, match='invalid_probe_size'):
        probe(**args)
