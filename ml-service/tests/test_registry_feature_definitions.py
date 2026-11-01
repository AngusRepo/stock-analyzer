"""Registry feature definitions under a PIT contract (data/feature_registry/pit_feature_definitions_v1.json).

Under pit_contract_version a defined feature follows alphabuilders_factors_fresh.json, on adjusted
prices derived as raw x same-day adj_close/close; without a version every feature keeps its
pre-contract form byte-identical (golden from 6ba6cb41)."""
import hashlib
from datetime import date, timedelta
from types import SimpleNamespace

import numpy as np
import pytest

from app import pit_contract
from app.features import build_feature_matrix
from app.pit_contract import CONTRACT_VERSION, feature_definitions

SESSIONS = [str(d) for d in (date(2025, 1, 2) + timedelta(days=i) for i in range(560)) if d.weekday() < 5]
EX_DATES = (60, 150, 260, 330)  # ex-right sessions: raw prices drop, the adjustment factor rises
# Legacy (no contract version) column bytes of the fixture below, computed at 6ba6cb41.
LEGACY_GOLDEN = {
    "tech_gap_down": "63019d55985329a82609c15ba1734dee753d9d302ba16e726287aadb12534b9a",
    "tech_gap_up": "d25a860e230aad781dd018bd808e6eada86cb132fe459f1b0f2cce46b3423546",
    "vola_cv_90d": "310de874ab903a1bd793b81385da3eb361c8db57f5f844138996d7a203a3a0bf",
}


def _fixture():
    """A raw bar series with ex-right drops and FinLab-style back-adjusted closes."""
    rng = np.random.default_rng(29)
    n = len(SESSIONS)
    close = np.empty(n)
    factor = np.empty(n)
    close[0], factor[0] = 80.0, 1.37
    for i in range(1, n):
        move = close[i - 1] * np.exp(rng.normal(0, 0.025))
        factor[i] = factor[i - 1]
        if i in EX_DATES:
            cash = round(close[i - 1] * 0.06, 2)
            factor[i] = factor[i - 1] * close[i - 1] / (close[i - 1] - cash)
            move -= cash
        close[i] = round(move, 2)
    spread = np.abs(rng.normal(0, 0.012, n)) * close
    high = np.round(close + spread * rng.random(n), 2)
    low = np.round(close - spread * rng.random(n), 2)
    opn = np.round(np.clip(close + rng.normal(0, 0.01, n) * close, low, high), 2)
    rows = [{"date": d, "open": float(opn[i]), "high": float(high[i]), "low": float(low[i]),
             "close": float(close[i]), "adj_close": float(close[i] * factor[i]),
             "volume": float(rng.integers(1_000, 90_000))} for i, d in enumerate(SESSIONS)]
    return rows


def _legacy(rows):
    return build_feature_matrix(rows, [], [], [], {}, historical_training=True)


def _contract(rows):
    return build_feature_matrix(rows, [], [], [], {"per_stock_ts": {}}, historical_training=True,
                                pit_contract_version=CONTRACT_VERSION)


def _sha(values) -> str:
    return hashlib.sha256(np.asarray(values, dtype=np.float64).tobytes()).hexdigest()


def _adjusted(rows):
    close = np.array([r["close"] for r in rows], dtype=float)
    factor = np.array([r["adj_close"] for r in rows], dtype=float) / close
    return (np.array([r["high"] for r in rows]) * factor, np.array([r["low"] for r in rows]) * factor)


def _bars(*bars):
    """(high, low, close, adj_close) per session; open = close."""
    return [{"date": SESSIONS[i], "open": c, "high": h, "low": lo, "close": c, "adj_close": a, "volume": 1000.0}
            for i, (h, lo, c, a) in enumerate(bars)]


def test_definitions_come_from_the_frozen_contract_file():
    definitions = feature_definitions(CONTRACT_VERSION)
    assert set(definitions) == set(pit_contract._DEFINED_FEATURES)
    assert definitions["tech_gap_down"]["tie_rel_tolerance"] == 1e-9
    assert definitions["tech_gap_down"]["undefined_value"] == 0.0


def test_editing_the_definitions_under_the_same_version_fails(monkeypatch):
    monkeypatch.setitem(pit_contract._FEATURE_DEFINITIONS_SHA256, CONTRACT_VERSION, "0" * 64)
    feature_definitions.cache_clear()
    try:
        with pytest.raises(ValueError, match="pit_feature_definitions_changed_without_new_version"):
            feature_definitions(CONTRACT_VERSION)
    finally:
        monkeypatch.undo()
        feature_definitions.cache_clear()


@pytest.mark.parametrize("name", sorted(LEGACY_GOLDEN))
def test_without_a_contract_every_definition_keeps_its_legacy_bytes(name):
    assert _sha(_legacy(_fixture())[name].to_numpy()) == LEGACY_GOLDEN[name]


def test_tech_gap_down_follows_the_registry_on_adjusted_prices():
    rows = _fixture()
    adj_high, adj_low = _adjusted(rows)
    expected = np.r_[0.0, (adj_high[1:] < adj_low[:-1] * (1 - 1e-9)).astype(float)]
    got = _contract(rows)["tech_gap_down"].to_numpy()
    assert got.tolist() == expected.tolist()
    assert 0 < got.sum() < len(got)
    # The legacy form is a continuous raw-price gap, so the contract output differs from it.
    assert _legacy(rows)["tech_gap_down"].to_list() != got.tolist()


def test_tech_gap_down_hand_cases():
    bars = _bars(
        (101.0, 99.0, 100.0, 100.0),       # 0 first row: undefined -> 0
        (98.0, 97.0, 97.5, 97.5),          # 1 high 98 < previous low 99: gap
        (97.0, 96.0, 96.5, 96.5),          # 2 high 97 == previous low 97: a tie is not a gap
        (50.0, 48.0, 48.0, 96.0),          # 3 ex-right (factor 1 -> 2): raw high 50 < 96, adjusted 100 > 96
        (47.9, 47.0, 47.5, 95.0),          # 4 same factor: adjusted high 95.8 < 96: gap
        (47.0, 46.0, 46.5, float("nan")),  # 5 no factor: undefined -> 0
        (40.0, 39.0, 39.5, 79.0),          # 6 previous row has no factor: undefined -> 0
    )
    assert _contract(bars)["tech_gap_down"].to_list() == [0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    # Raw prices disagree on the ex-right day: the legacy form reports the distribution as a gap.
    assert _legacy(bars)["tech_gap_down"].to_list()[3] < 0


def test_a_one_ulp_vendor_tie_on_an_ex_right_day_is_not_a_gap():
    # The ex-right drop equals the distribution, so the adjusted high equals the previous adjusted
    # low up to one ulp, below it here (FinLab capture 2882 2022-07-04 had the same).
    previous_adj = 50.0 * 1.37
    tie_adj = 45.7 * (49.7 * (previous_adj / 50.0) / 46.2)
    bars = _bars((51.0, 49.7, 50.0, previous_adj), (46.2, 45.5, 45.7, tie_adj))
    adj_high, adj_low = _adjusted(bars)
    assert adj_high[1] < adj_low[0] and adj_low[0] / adj_high[1] - 1 < 1e-15
    assert _contract(bars)["tech_gap_down"].to_list() == [0.0, 0.0]
    # A real gap just beyond the tolerance still counts.
    bars[1]["adj_close"] = tie_adj * (1 - 1e-8)
    assert _contract(bars)["tech_gap_down"].to_list() == [0.0, 1.0]


def test_a_vendor_rebase_of_the_whole_series_changes_nothing():
    rows = _fixture()
    rebased = [{**r, "adj_close": r["adj_close"] * 0.731} for r in rows]
    for name in pit_contract._DEFINED_FEATURES:
        assert _contract(rebased)[name].to_list() == _contract(rows)[name].to_list()


def test_a_versioned_serving_request_builds_the_registry_definitions():
    from app.batch_prediction import _build_feature_batch_context

    rows = _fixture()

    def request(version):
        return SimpleNamespace(prices=rows, indicators=[], chips=[], sentiment_scores=[],
                               market_env={"per_stock_ts": {}}, barrier_params=None, stock_meta=None,
                               market="TWSE", pit_contract_version=version)
    legacy, contract = _build_feature_batch_context(request(None)), _build_feature_batch_context(request(VERSION))
    assert contract.feature_names == legacy.feature_names
    for name in pit_contract._DEFINED_FEATURES:
        column = legacy.feature_names.index(name)
        assert legacy.x_latest[0, column] == _legacy(rows)[name].to_list()[-1]
        assert contract.x_latest[0, column] == _contract(rows)[name].to_list()[-1]


VERSION = CONTRACT_VERSION
