from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.optuna_route_policy import OptunaRoutePolicy  # noqa: E402


def test_optuna_route_policy_keeps_existing_safe_defaults():
    policy = OptunaRoutePolicy.from_env()

    assert policy.barrier_min_price_rows == 200
    assert policy.barrier_top_n == 10
    assert policy.signal_order_limit == 500
    assert policy.signal_prediction_limit == 2000
    assert policy.signal_min_orders == 20
    assert policy.signal_min_predictions == 50
    assert policy.conformal_prediction_limit == 2000
    assert policy.conformal_min_labeled_predictions == 50
    assert policy.risk_daily_pnl_limit == 200
    assert policy.risk_min_daily_snapshots == 20
    assert policy.risk_min_daily_returns == 20
    assert policy.rrg_twii_limit == 500
    assert policy.rrg_min_twii_rows == 60
    assert policy.rrg_stock_price_limit == 500
    assert policy.rrg_top_stock_min_rows == 100
    assert policy.rrg_top_stock_count == 10
    assert policy.feature_window_twii_limit == 1000
    assert policy.feature_window_min_twii_rows == 100


def test_optuna_route_policy_reads_env_overrides(monkeypatch):
    monkeypatch.setenv("OPTUNA_BARRIER_MIN_PRICE_ROWS", "252")
    monkeypatch.setenv("OPTUNA_SIGNAL_MIN_ORDERS", "35")
    monkeypatch.setenv("OPTUNA_RRG_TOP_STOCK_COUNT", "30")
    monkeypatch.setenv("OPTUNA_FEATURE_WINDOW_TWII_LIMIT", "1500")

    policy = OptunaRoutePolicy.from_env()

    assert policy.barrier_min_price_rows == 252
    assert policy.signal_min_orders == 35
    assert policy.rrg_top_stock_count == 30
    assert policy.feature_window_twii_limit == 1500


def test_optuna_route_policy_ignores_invalid_env(monkeypatch):
    monkeypatch.setenv("OPTUNA_SIGNAL_MIN_PREDICTIONS", "not-int")

    policy = OptunaRoutePolicy.from_env()

    assert policy.signal_min_predictions == 50
