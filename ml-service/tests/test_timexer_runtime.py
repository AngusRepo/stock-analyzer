import numpy as np
import pytest

from app.timexer_runtime import ARCHITECTURE, OFFICIAL_COMMIT, causal_input, validate_settings


def sources():
    dates = np.arange(np.datetime64('2025-01-01'), np.datetime64('2025-01-01') + 180).astype(str)
    prices = np.linspace(30, 70, 180, dtype=np.float32)
    features = np.arange(180 * 137, dtype=np.float32).reshape(180, 137) / 1000
    return dates, prices, features


def test_exact_accepted_capacity_and_variant_are_required():
    settings = {**ARCHITECTURE, 'official_commit': OFFICIAL_COMMIT}
    validate_settings(settings, False)
    validate_settings(settings, True)
    with pytest.raises(ValueError, match='architecture'):
        validate_settings({**settings, 'd_model': 64}, False)
    with pytest.raises(ValueError, match='source_or_variant'):
        validate_settings({**settings, 'official_commit': 'latest'}, False)


@pytest.mark.parametrize('exogenous', [False, True])
def test_causal_input_does_not_consume_future_prices_or_features(exogenous):
    dates, prices, matrix = sources()
    settings = {**ARCHITECTURE, 'official_commit': OFFICIAL_COMMIT}
    before = causal_input((dates, prices), (dates, matrix), dates, dates[169], settings=settings, exogenous=exogenous)
    prices[170:] *= 100
    matrix[170:] = -99999
    after = causal_input((dates, prices), (dates, matrix), dates, dates[169], settings=settings, exogenous=exogenous)
    assert before[0].shape == (168, 138 if exogenous else 1)
    np.testing.assert_array_equal(before[0], after[0])
    assert before[1:] == after[1:]
    if exogenous:
        np.testing.assert_array_equal(before[0][:, :-1], matrix[2:170])


def test_price_only_values_are_independent_of_exogenous_values():
    dates, prices, matrix = sources()
    settings = {**ARCHITECTURE, 'official_commit': OFFICIAL_COMMIT}
    a = causal_input((dates, prices), (dates, matrix), dates, dates[-1], settings=settings, exogenous=False)
    b = causal_input((dates, prices), (dates, matrix * -30), dates, dates[-1], settings=settings, exogenous=False)
    np.testing.assert_array_equal(a[0], b[0])


def test_signal_day_is_mandatory_and_stale_feature_gap_is_bounded():
    dates, prices, matrix = sources()
    settings = {**ARCHITECTURE, 'official_commit': OFFICIAL_COMMIT}
    assert causal_input((dates, prices), (dates[:-1], matrix[:-1]), dates, dates[-1], settings=settings, exogenous=True) is None
    one = np.arange(180) != 20
    assert causal_input((dates, prices), (dates[one], matrix[one]), dates, dates[-1], settings=settings, exogenous=True) is not None
    two = ~np.isin(np.arange(180), [20, 21])
    assert causal_input((dates, prices), (dates[two], matrix[two]), dates, dates[-1], settings=settings, exogenous=True) is None
    assert causal_input((dates, prices), (dates, matrix), dates, dates[100], settings=settings, exogenous=True) is None


def test_bad_feature_order_and_nonfinite_observed_values_fail_explicitly():
    dates, prices, matrix = sources()
    settings = {**ARCHITECTURE, 'official_commit': OFFICIAL_COMMIT}
    with pytest.raises(ValueError, match='shape_or_order'):
        causal_input((dates[::-1], prices), (dates, matrix), dates, dates[-1], settings=settings, exogenous=True)
    matrix[-1, 0] = np.nan
    with pytest.raises(ValueError, match='nonfinite'):
        causal_input((dates, prices), (dates, matrix), dates, dates[-1], settings=settings, exogenous=True)
