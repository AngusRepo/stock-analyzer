"""Policy for legacy Optuna route data sufficiency and sample bounds."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class OptunaRoutePolicy:
    barrier_min_price_rows: int = 200
    barrier_top_n: int = 10
    signal_order_limit: int = 500
    signal_prediction_limit: int = 2000
    signal_min_orders: int = 20
    signal_min_predictions: int = 50
    conformal_prediction_limit: int = 2000
    conformal_min_labeled_predictions: int = 50
    risk_daily_pnl_limit: int = 200
    risk_min_daily_snapshots: int = 20
    risk_min_daily_returns: int = 20
    rrg_twii_limit: int = 500
    rrg_min_twii_rows: int = 60
    rrg_stock_price_limit: int = 500
    rrg_top_stock_min_rows: int = 100
    rrg_top_stock_count: int = 10
    feature_window_twii_limit: int = 1000
    feature_window_min_twii_rows: int = 100

    @classmethod
    def from_env(cls) -> "OptunaRoutePolicy":
        return cls(
            barrier_min_price_rows=_env_int("OPTUNA_BARRIER_MIN_PRICE_ROWS", cls.barrier_min_price_rows),
            barrier_top_n=_env_int("OPTUNA_BARRIER_TOP_N", cls.barrier_top_n),
            signal_order_limit=_env_int("OPTUNA_SIGNAL_ORDER_LIMIT", cls.signal_order_limit),
            signal_prediction_limit=_env_int("OPTUNA_SIGNAL_PREDICTION_LIMIT", cls.signal_prediction_limit),
            signal_min_orders=_env_int("OPTUNA_SIGNAL_MIN_ORDERS", cls.signal_min_orders),
            signal_min_predictions=_env_int("OPTUNA_SIGNAL_MIN_PREDICTIONS", cls.signal_min_predictions),
            conformal_prediction_limit=_env_int(
                "OPTUNA_CONFORMAL_PREDICTION_LIMIT",
                cls.conformal_prediction_limit,
            ),
            conformal_min_labeled_predictions=_env_int(
                "OPTUNA_CONFORMAL_MIN_LABELED_PREDICTIONS",
                cls.conformal_min_labeled_predictions,
            ),
            risk_daily_pnl_limit=_env_int("OPTUNA_RISK_DAILY_PNL_LIMIT", cls.risk_daily_pnl_limit),
            risk_min_daily_snapshots=_env_int(
                "OPTUNA_RISK_MIN_DAILY_SNAPSHOTS",
                cls.risk_min_daily_snapshots,
            ),
            risk_min_daily_returns=_env_int("OPTUNA_RISK_MIN_DAILY_RETURNS", cls.risk_min_daily_returns),
            rrg_twii_limit=_env_int("OPTUNA_RRG_TWII_LIMIT", cls.rrg_twii_limit),
            rrg_min_twii_rows=_env_int("OPTUNA_RRG_MIN_TWII_ROWS", cls.rrg_min_twii_rows),
            rrg_stock_price_limit=_env_int("OPTUNA_RRG_STOCK_PRICE_LIMIT", cls.rrg_stock_price_limit),
            rrg_top_stock_min_rows=_env_int(
                "OPTUNA_RRG_TOP_STOCK_MIN_ROWS",
                cls.rrg_top_stock_min_rows,
            ),
            rrg_top_stock_count=_env_int("OPTUNA_RRG_TOP_STOCK_COUNT", cls.rrg_top_stock_count),
            feature_window_twii_limit=_env_int(
                "OPTUNA_FEATURE_WINDOW_TWII_LIMIT",
                cls.feature_window_twii_limit,
            ),
            feature_window_min_twii_rows=_env_int(
                "OPTUNA_FEATURE_WINDOW_MIN_TWII_ROWS",
                cls.feature_window_min_twii_rows,
            ),
        )

    def to_dict(self) -> dict:
        return asdict(self)
