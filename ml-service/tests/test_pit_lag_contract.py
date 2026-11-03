"""T2 (C28-02): contract lags count the stock's own price rows, never KV holidays."""
from datetime import date, timedelta

import pytest

from app.features import build_feature_matrix
from app.pit_contract import feature_lags

VERSION = "pit-availability-contract-v1"
# Price rows: 2026-07-10 (typhoon, missing from KV) and a long holiday have none.
CLOSED = {date(2026, 7, 10)} | {date(2026, 7, 20) + timedelta(days=i) for i in range(9)}
DAYS = [d for d in (date(2026, 6, 1) + timedelta(days=i) for i in range(100))
        if d.weekday() < 5 and d not in CLOSED]
FIELDS = ("revenue", "revenue_yoy", "revenue_mom", "eps", "roe", "revenue_growth_yoy")


def _prices(days=DAYS):
    return [{"date": str(d), "open": 100 + i, "high": 102 + i, "low": 99 + i, "close": 101 + i,
             "adj_close": 101 + i, "volume": 10000 + i} for i, d in enumerate(days)]


def _chips(days=DAYS):
    return [{"date": str(d), "margin_balance": 1000.0 + i, "short_balance": 50.0 + i, "foreign_net": 7.0 + i}
            for i, d in enumerate(days)]


def _build(version, *, days=DAYS, history=None, chips=None, market_env=None, historical=True):
    env = {"per_stock_ts": history or {}, **(market_env or {})}
    df = build_feature_matrix(_prices(days), [], _chips(days) if chips is None else chips, [], env,
                              historical_training=historical, pit_contract_version=version)
    return df, {str(d): i for i, d in enumerate(df["date"].to_list())}


def _release(key):
    return {key: {"revenue": 5.0, "revenue_yoy": 0.1, "revenue_mom": 0.2, "eps": 2.0, "roe": 3.0,
                  "revenue_growth_yoy": 0.3}}


def test_contract_lags_are_the_ones_the_feature_layer_applies():
    assert feature_lags(VERSION) == {"margin_balance": 1, "short_balance": 1, "short_ratio": 1, "revenue": 1,
                                     "revenue_yoy": 1, "revenue_mom": 1, "eps": 1, "roe": 1,
                                     "revenue_growth_yoy": 1}


def test_margin_and_short_are_usable_the_next_session_across_typhoon_and_long_holiday():
    df, row = _build(VERSION)
    base, _ = _build(None)
    for day, previous in (("2026-07-13", "2026-07-09"), ("2026-07-29", "2026-07-17"), ("2026-06-02", "2026-06-01")):
        assert df["margin_balance"][row[day]] == base["margin_balance"][row[previous]]
        assert df["short_balance"][row[day]] == base["short_balance"][row[previous]]
    # Institutional flow is level R with lag 0: the same session.
    assert df["foreign_5d"].to_list() == base["foreign_5d"].to_list()


@pytest.mark.parametrize("key, first_without, first_with", [
    ("2026-06-10", "2026-06-10", "2026-06-11"),  # revenue deadline on a session: not the same day
    ("2026-07-10", "2026-07-13", "2026-07-14"),  # vendor key on the typhoon day
    ("2026-07-18", "2026-07-29", "2026-07-30"),  # weekend key into a long holiday
    ("2026-08-14", "2026-08-14", "2026-08-17"),  # quarterly financial deadline, Friday
])
def test_revenue_and_financials_are_usable_one_session_after_first_session(key, first_without, first_with):
    days = [str(d) for d in DAYS]
    base, row = _build(None, history=_release(key))
    df, _ = _build(VERSION, history=_release(key))
    before = days[days.index(first_without) - 1]
    for field in FIELDS:
        value = _release(key)[key][field]
        assert base[field][row[before]] == 0.0 and base[field][row[first_without]] == value, field
        assert df[field][row[first_without]] == 0.0 and df[field][row[first_with]] == value, field


def test_a_suspended_stock_counts_its_own_sessions():
    suspended = [d for d in DAYS if d != date(2026, 7, 15)]
    df, row = _build(VERSION, days=suspended)
    assert df["margin_balance"][row["2026-07-16"]] == 1000.0 + suspended.index(date(2026, 7, 14))


def test_lagged_fields_never_fall_back_to_a_same_day_serving_scalar():
    scalars = {"eps": 9.9, "revenue": 8.8, "revenue_yoy": 0.4, "margin_balance": 7.7, "pe": 12.0}
    base, _ = _build(None, chips=[], market_env=scalars, historical=False)
    df, _ = _build(VERSION, chips=[], market_env=scalars, historical=False)
    assert base["eps"][-1] == 9.9 and base["revenue"][-1] == 8.8
    assert df["eps"][-1] == 0.0 and df["revenue"][-1] == 0.0
    assert df["pe"][-1] == base["pe"][-1] == 12.0
    # The audit mask reports the gap the refused scalar leaves, not the scalar.
    for name in ("l1_eps", "l1_monthlyRevenueYoY", "val_sp"):
        assert not base["_source_missing__" + name][-1] and df["_source_missing__" + name][-1], name
    assert not df["_source_missing__val_ep"][-1]


def test_no_contract_version_is_byte_identical_to_the_pre_contract_call():
    history = _release("2026-07-10")
    env = {"per_stock_ts": history}
    legacy = build_feature_matrix(_prices(), [], _chips(), [], env, historical_training=True)
    explicit, _ = _build(None, history=history)
    assert legacy.equals(explicit)
    lagged, _ = _build(VERSION, history=history)
    assert not legacy.equals(lagged)


def test_serving_refuses_features_built_without_the_artifacts_contract_lags():
    import numpy as np
    from types import SimpleNamespace
    from app.batch_prediction import _FeatureBatchContext, _align_latest_features
    from app.pit_contract import artifact_contract_version

    def ctx(version):
        # The guard reads the version the features were built with, not the request field.
        return _FeatureBatchContext(req=SimpleNamespace(pit_contract_version="not-read"),
                                    x_latest=np.array([[1.0]]), feature_names=["f"], pit_contract_version=version)
    legacy = {"feature_names": ["f"], "feature_medians": {}}
    pit = {**legacy, "dataset": {"deployment_fit": {"input_scope": {"pit_contract_version": VERSION}}}}
    assert artifact_contract_version(pit) == VERSION and artifact_contract_version(legacy) is None
    # Neither side carries a version: today's serving, unchanged.
    assert _align_latest_features(ctx(None), legacy) is not None
    assert _align_latest_features(_FeatureBatchContext(req=None, x_latest=np.array([[1.0]]), feature_names=["f"]),
                                  legacy) is not None
    assert _align_latest_features(ctx(VERSION), pit) is not None
    for request, meta in ((None, pit), (VERSION, legacy)):
        with pytest.raises(ValueError, match="pit_contract_version_serving_mismatch"):
            _align_latest_features(ctx(request), meta)
    with pytest.raises(ValueError, match="pit_contract_version_ambiguous"):
        artifact_contract_version({"a": {"pit_contract_version": VERSION}, "b": [{"pit_contract_version": "v0"}]})


def test_a_versioned_serving_request_builds_lagged_features():
    from types import SimpleNamespace
    from app.batch_prediction import _build_feature_batch_context

    def request(version):
        return SimpleNamespace(prices=_prices(), indicators=[], chips=_chips(), sentiment_scores=[],
                               market_env={"per_stock_ts": {}}, barrier_params=None, stock_meta=None,
                               market="TWSE", pit_contract_version=version)
    legacy, lagged = _build_feature_batch_context(request(None)), _build_feature_batch_context(request(VERSION))
    assert (legacy.pit_contract_version, lagged.pit_contract_version) == (None, VERSION)
    column = legacy.feature_names.index("margin_balance")
    assert lagged.feature_names == legacy.feature_names
    # The latest row carries the previous session's margin balance only under the contract.
    assert legacy.x_latest[0, column] == 1000.0 + len(DAYS) - 1
    assert lagged.x_latest[0, column] == 1000.0 + len(DAYS) - 2
    # Lagged fields refuse same-day scalars, so a versioned request must carry their history.
    bare = request(VERSION)
    bare.market_env = {}
    with pytest.raises(ValueError, match="pit_lagged_history_missing"):
        _build_feature_batch_context(bare)
    bare.pit_contract_version = None
    assert _build_feature_batch_context(bare).pit_contract_version is None
