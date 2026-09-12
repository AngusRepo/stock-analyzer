import numpy as np
import pytest

from scripts.nav_bootstrap_prototype import BootstrapPolicy, circular_block_indices, hac_mean_se, infer_paired_nav


def test_missing_nav_is_not_dropped_and_zero_is_not_missing():
    assert infer_paired_nav([0.] * 9, alpha=.0125, seed=1)['reason'] == 'nav_sessions_incomplete'
    assert infer_paired_nav([0.] * 10, alpha=.0125, seed=1)['reason'] == 'nav_variance_unidentified'
    row = infer_paired_nav([.01] * 9 + [None], alpha=.0125, seed=1)
    assert row['reason'] == 'nav_valuation_incomplete' and row['sessions'] == 10 and row['exact_nav_sessions'] == 9


@pytest.mark.parametrize('value', [True, '0.01', float('nan'), float('inf')])
def test_bad_return_cannot_become_observed_score(value):
    with pytest.raises(ValueError, match='invalid_return'):
        infer_paired_nav([.01] * 9 + [value], alpha=.0125, seed=1)


def test_circular_blocks_preserve_contiguous_paired_dates():
    indices = circular_block_indices(np.random.default_rng(7), 10, 3, 100)
    assert indices.shape == (100, 10)
    for start in (0, 3, 6):
        assert np.all(np.diff(indices[:, start:start+3], axis=1) % 10 == 1)


def test_hac_zero_lag_matches_sample_mean_standard_error():
    x = np.random.default_rng(13).normal(size=(10, 25))
    np.testing.assert_allclose(hac_mean_se(x, 0), x.std(axis=1, ddof=1) / 5)


def test_replay_and_scale_are_exactly_reproducible_without_changing_endpoint():
    x = np.random.default_rng(9).normal(.002, .0005, 40)
    a = infer_paired_nav(x.tolist(), alpha=.0125, seed=123)
    assert a == infer_paired_nav(x.tolist(), alpha=.0125, seed=123)
    b = infer_paired_nav((x * 100).tolist(), alpha=.0125, seed=123)
    assert a['decision'] == b['decision'] == 'PASS'
    assert a['bootstrap_p_mc_upper'] == b['bootstrap_p_mc_upper']
    assert b['mean_delta_lcb'] == pytest.approx(a['mean_delta_lcb'] * 100)
    assert a['mean_delta'] == pytest.approx(x.mean())
    assert a['universal_finite_sample_guarantee'] is False
    assert a['promotion_allowed'] is False
    assert a['calibration_status'] == 'rejected_for_automatic_promotion'


def test_negative_effect_and_low_resolution_never_claim_pass():
    x = np.random.default_rng(9).normal(.002, .0005, 40)
    assert infer_paired_nav((-x).tolist(), alpha=.0125, seed=123)['decision'] == 'HOLD'
    row = infer_paired_nav(x.tolist(), alpha=1e-7, seed=123,
                          policy=BootstrapPolicy(resamples=999, max_resamples=999))
    assert row['resamples_completed'] == 0
    assert row['minimum_tail_resamples'] > 999
    assert row['reason'] == 'bootstrap_tail_resolution_insufficient' and row['decision'] == 'HOLD'


def test_fifth_daily_look_is_not_numerically_impossible_with_a_fixed_9999_draws():
    # Ten-session first look; at session14 the fifth look owns .025/(5*6).
    x = np.random.default_rng(9).normal(.002, .00005, 14).tolist()
    alpha = .025 / (5 * 6)
    old = infer_paired_nav(x, alpha=alpha, seed=123,
                          policy=BootstrapPolicy(max_resamples=9999))
    new = infer_paired_nav(x, alpha=alpha, seed=123)
    assert old['reason'] == 'bootstrap_tail_resolution_insufficient'
    assert new['resamples_completed'] > 9999
    assert new['bootstrap_p_mc_upper'] <= new['bootstrap_test_alpha']
    assert new['decision'] == 'PASS' and new['promotion_allowed'] is False


def test_budget_sized_resampling_is_not_changed_by_observed_returns():
    a = infer_paired_nav([.001, .003] * 7, alpha=.0008, seed=1)
    b = infer_paired_nav([-.001, -.003] * 7, alpha=.0008, seed=1)
    assert a['resamples_planned'] == b['resamples_planned'] > 9999


@pytest.mark.parametrize('kwargs', [{'alpha':0}, {'alpha':True}, {'seed':-1}, {'seed':True}, {'block_length':10}])
def test_invalid_statistical_configuration_refused(kwargs):
    with pytest.raises(ValueError):
        infer_paired_nav([.001, .003] * 5, **({'alpha':.0125, 'seed':1} | kwargs))
