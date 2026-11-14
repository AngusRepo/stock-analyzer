"""NEW-75: under a PIT contract tech_obv is a fixed-window sum that does not depend on
where the payload history starts; without a contract it stays the legacy cumulative sum."""
from datetime import date, timedelta

import numpy as np
import polars as pl
import pytest

from app import pit_contract
from app.features import build_feature_matrix
from app.pit_contract import CONTRACT_VERSION, feature_windows

SESSIONS = [str(d) for d in (date(2025, 1, 2) + timedelta(days=i) for i in range(420)) if d.weekday() < 5]


def _prices(fractional: bool):
    rng = np.random.default_rng(3)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, len(SESSIONS))))
    close[[40, 41, 90]] = close[[39, 40, 89]]  # unchanged closes contribute 0
    volume = rng.integers(1_000, 90_000, len(SESSIONS)).astype(float)
    if fractional:
        volume = volume * rng.choice([1.0, 1e-3, 1e3], len(SESSIONS)) + rng.random(len(SESSIONS))
    rows = []
    for i, (d, c, v) in enumerate(zip(SESSIONS, close, volume)):
        row = {"date": d, "open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "adj_close": c}
        if i != 120:  # one missing volume
            row["volume"] = float("nan") if i == 200 else v  # and one NaN volume
        rows.append(row)
    return rows


def _obv(prices, version):
    df = build_feature_matrix(prices, [], [], [], {"per_stock_ts": {}, "history": {}},
                              historical_training=True, pit_contract_version=version)
    return df["date"].cast(str).to_list(), df["tech_obv"].cast(pl.Float64).to_numpy()


def _signed(prices):
    close = np.array([p["close"] for p in prices])
    volume = np.array([p.get("volume", np.nan) for p in prices])
    move = np.sign(np.r_[0.0, np.diff(close)])
    return close, volume, move


def test_window_comes_from_the_frozen_contract_file():
    assert feature_windows(CONTRACT_VERSION) == {"tech_obv": 21}


def test_editing_the_window_under_the_same_version_fails(monkeypatch):
    monkeypatch.setitem(pit_contract._FEATURE_WINDOWS_SHA256, CONTRACT_VERSION, "0" * 64)
    feature_windows.cache_clear()
    try:
        with pytest.raises(ValueError, match="pit_feature_windows_changed_without_new_version"):
            feature_windows(CONTRACT_VERSION)
    finally:
        monkeypatch.undo()
        feature_windows.cache_clear()


def test_without_a_contract_tech_obv_is_the_legacy_cumulative_sum():
    prices = _prices(fractional=True)
    _dates, obv = _obv(prices, None)
    frame = pl.DataFrame(prices, infer_schema_length=None).with_columns(pl.col("volume").cast(pl.Float64))
    close, volume = pl.col("close"), pl.col("volume")
    legacy = frame.select(pl.when(close > close.shift(1)).then(volume).when(close < close.shift(1)).then(-volume)
                          .otherwise(0.0).cum_sum()).to_series().to_numpy()
    observed = ~np.isnan(legacy)  # null from the missing volume, NaN after the NaN volume: imputed downstream
    assert observed[:120].all() and not observed[120]
    assert obv[observed].view(np.int64).tolist() == legacy[observed].view(np.int64).tolist()


@pytest.mark.parametrize("fractional", [False, True])
def test_contract_tech_obv_is_the_last_window_of_signed_volume(fractional):
    prices = _prices(fractional)
    _dates, obv = _obv(prices, CONTRACT_VERSION)
    _close, volume, move = _signed(prices)
    flow = np.where(move != 0, np.nan_to_num(volume) * move, 0.0)
    window = feature_windows(CONTRACT_VERSION)["tech_obv"]
    assert (obv[:window] == 0.0).all()  # null until window + 1 rows, then the shared imputation (no prior: 0)
    expected = np.array([flow[i - window + 1:i + 1].sum() for i in range(window, len(flow))])
    assert np.allclose(obv[window:], expected, rtol=1e-12, atol=1e-6)


@pytest.mark.parametrize("fractional", [False, True])
def test_contract_tech_obv_does_not_depend_on_the_history_start(fractional):
    prices = _prices(fractional)
    dates, full = _obv(prices, CONTRACT_VERSION)
    window = feature_windows(CONTRACT_VERSION)["tech_obv"]
    for start in (1, 13, 57, 150):
        cut_dates, cut = _obv(prices[start:], CONTRACT_VERSION)
        offset = dates.index(cut_dates[0])
        assert cut_dates == dates[offset:]
        # Bit-identical once the shorter history has a full window and the close before it.
        assert full[offset + window:].view(np.int64).tolist() == cut[window:].view(np.int64).tolist()


def test_the_legacy_level_does_depend_on_the_history_start():
    prices = _prices(fractional=False)
    _dates, full = _obv(prices, None)
    _cut_dates, cut = _obv(prices[57:], None)
    assert not np.array_equal(full[57:], cut)
