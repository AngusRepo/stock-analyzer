"""
_predictions_schema.py — D1 `predictions` table column constants + shared types

shared between recommendation_service.py (write) and verify_service.py (update).
Mirror of worker/src/lib/_predictionsSchema.ts (must keep in sync 1:1).

Source of truth for column names — change here and the TS file together.
"""
from dataclasses import dataclass, field
from typing import Literal


# ── Column name constants (字串常數，避免 typo)─────────────────────────────────
# Insert columns (recommendation_service.py 寫入時用)
COL_STOCK_ID = "stock_id"
COL_MODEL_NAME = "model_name"
COL_GENERATED_AT = "generated_at"
COL_HORIZON = "horizon"
COL_DIRECTION_ACCURACY = "direction_accuracy"  # 注意: 寫入時是 confidence，verify 後欄位語意不變
COL_FORECAST_DATA = "forecast_data"
COL_ENTRY_PRICE = "entry_price"
COL_STOP_LOSS = "stop_loss"
COL_TARGET1 = "target1"
COL_TARGET2 = "target2"
COL_TRADE_SIGNAL = "trade_signal"
COL_FEATURE_VERSION = "feature_version"
COL_SIGNAL_RAW = "signal_raw"

# Verify-update columns (verify_service.py UPDATE 時用)
COL_PREDICTED_DIRECTION = "predicted_direction"
COL_PREDICTED_PRICE = "predicted_price"
COL_ACTUAL_DIRECTION = "actual_direction"
COL_ACTUAL_PRICE = "actual_price"
COL_DIRECTION_CORRECT = "direction_correct"
COL_PRICE_ERROR_PCT = "price_error_pct"
COL_MARKET_RISK_LEVEL = "market_risk_level"
COL_MARKET_RISK_SCORE = "market_risk_score"
COL_ACTUAL_RETURN_PCT = "actual_return_pct"
COL_TRADE_OUTCOME = "trade_outcome"
COL_TRADE_PNL_PCT = "trade_pnl_pct"
COL_TRADE_PNL_R = "trade_pnl_r"
COL_MAX_FAVORABLE_PCT = "max_favorable_pct"
COL_MAX_ADVERSE_PCT = "max_adverse_pct"
COL_VERIFIED_AT = "verified_at"


# ── Insert SQL (recommendation_service 共用) ──────────────────────────────────
INSERT_PREDICTIONS_SQL = f"""
INSERT INTO predictions (
    {COL_STOCK_ID}, {COL_MODEL_NAME}, {COL_GENERATED_AT}, {COL_HORIZON}, {COL_DIRECTION_ACCURACY},
    {COL_FORECAST_DATA}, {COL_ENTRY_PRICE}, {COL_STOP_LOSS}, {COL_TARGET1}, {COL_TARGET2},
    {COL_TRADE_SIGNAL}, {COL_FEATURE_VERSION}, {COL_SIGNAL_RAW}
) VALUES (?, 'ensemble', datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""".strip()

# ── Verify update SQL ─────────────────────────────────────────────────────────
UPDATE_VERIFY_SQL = f"""
UPDATE predictions SET
    {COL_PREDICTED_DIRECTION} = ?,
    {COL_PREDICTED_PRICE}     = ?,
    {COL_ACTUAL_DIRECTION}    = ?,
    {COL_ACTUAL_PRICE}        = ?,
    {COL_DIRECTION_CORRECT}   = ?,
    {COL_PRICE_ERROR_PCT}     = ?,
    {COL_MARKET_RISK_LEVEL}   = ?,
    {COL_MARKET_RISK_SCORE}   = ?,
    {COL_ACTUAL_RETURN_PCT}   = ?,
    {COL_TRADE_OUTCOME}       = ?,
    {COL_TRADE_PNL_PCT}       = ?,
    {COL_TRADE_PNL_R}         = ?,
    {COL_MAX_FAVORABLE_PCT}   = ?,
    {COL_MAX_ADVERSE_PCT}     = ?,
    {COL_VERIFIED_AT}         = datetime('now')
WHERE id = ?
""".strip()


# ── Shared types ──────────────────────────────────────────────────────────────

TradeOutcome = Literal["expired", "hit_target1", "hit_target2", "hit_stop"]
Direction = Literal["up", "down", "neutral"]


@dataclass
class Bar:
    """Single OHLC bar — matches D1 stock_prices row shape"""
    date: str
    open: float
    high: float
    low: float
    close: float


@dataclass
class ForecastEntry:
    """Single horizon point inside forecast_data.forecasts[]"""
    forecast: float
    lower95: float | None = None
    upper95: float | None = None


@dataclass
class ForecastData:
    """JSON payload stored in predictions.forecast_data column"""
    signal: str = ""                              # BUY / SELL / HOLD / STRONG_BUY etc.
    forecasts: list[dict] = field(default_factory=list)  # ForecastEntry-shaped dicts
    arf_features: list[float] = field(default_factory=list)


@dataclass
class TradeSimulationResult:
    """Output of simulate_trade() — matches worker simulateTrade return"""
    outcome: TradeOutcome
    trade_pnl_pct: float
    trade_pnl_r: float
    max_favorable: float
    max_adverse: float
