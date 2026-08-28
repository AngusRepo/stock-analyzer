from __future__ import annotations

import inspect
from pathlib import Path
import sys

import numpy as np

ML_CONTROLLER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_CONTROLLER_ROOT))

from services import backtest_engine
from services import stratified_subset


def test_high_price_low_share_volume_passes_execution_capacity() -> None:
    closes = np.full(20, 200.0)
    volumes = np.full(20, 100_000.0)
    assert backtest_engine._median_daily_traded_value(closes, volumes) == 20_000_000.0


def test_spikes_do_not_override_thin_median_liquidity() -> None:
    closes = np.concatenate([np.full(11, 10.0), np.full(9, 100.0)])
    volumes = np.concatenate([np.full(11, 100_000.0), np.full(9, 1_000_000.0)])
    assert backtest_engine._median_daily_traded_value(closes, volumes) == 1_000_000.0


def test_insufficient_observations_fail_closed() -> None:
    assert backtest_engine._median_daily_traded_value(
        np.array([100.0, 100.0]),
        np.array([1_000_000.0, 1_000_000.0]),
    ) is None


def test_backtest_and_optuna_retire_share_volume_selector() -> None:
    assert backtest_engine.ScreenerParams().min_daily_turnover == 13_000_000
    replay_source = inspect.getsource(backtest_engine.replay_screener_for_date)
    assert "avg_vol_20 < screener.min_avg_volume" not in replay_source
    assert "_median_daily_traded_value(closes, volumes)" in replay_source

    from optuna_scripts import optuna_screener

    trial_source = inspect.getsource(optuna_screener._build_trial_params)
    assert 'suggest_int("minAvgVolume"' not in trial_source
    assert 'suggest_int("minDailyTurnover"' not in trial_source



def test_research_subset_uses_last_20_sessions_not_full_query_window(monkeypatch) -> None:
    rows: list[dict[str, object]] = []
    daily_values = [100_000_000.0] + [1_000_000.0] * 10 + [20_000_000.0] * 10
    for index, daily_value in enumerate(daily_values, start=1):
        rows.append({
            "symbol": "WINDOW_PARITY",
            "sector": "A",
            "date": f"2026-07-{index:02d}",
            "close": 1.0,
            "volume": daily_value,
        })
    monkeypatch.setattr(
        stratified_subset,
        "load_market_price_rows_with_identity",
        lambda **_: rows,
    )
    selected = stratified_subset.select_stratified_subset(
        target_size=10,
        end_date="2026-07-21",
        lookback_days=30,
        min_median_daily_traded_value=13_000_000,
    )
    assert selected == []


def test_research_subset_uses_median_value_and_hash_not_liquidity_rank(monkeypatch) -> None:
    rows: list[dict[str, object]] = []
    for date_index in range(5):
        rows.extend([
            {
                "symbol": "HIGH_PRICE",
                "sector": "A",
                "date": f"2026-08-{date_index + 1:02d}",
                "close": 200.0,
                "volume": 100_000.0,
            },
            {
                "symbol": "SPIKY",
                "sector": "A",
                "date": f"2026-08-{date_index + 1:02d}",
                "close": 10.0,
                "volume": 100_000.0 if date_index < 3 else 10_000_000.0,
            },
        ])
    monkeypatch.setattr(
        stratified_subset,
        "load_market_price_rows_with_identity",
        lambda **_: rows,
    )
    selected = stratified_subset.select_stratified_subset(
        target_size=10,
        end_date="2026-08-05",
        lookback_days=30,
        min_median_daily_traded_value=13_000_000,
    )
    assert selected == ["HIGH_PRICE"]
    source = inspect.getsource(stratified_subset.select_stratified_subset)
    assert 'x["avg_vol"]' not in source
    assert "sample_key" in source
