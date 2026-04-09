/**
 * _predictionsSchema.ts — D1 `predictions` table column constants + shared types
 *
 * Mirror of ml-controller/services/_predictions_schema.py (must keep in sync 1:1).
 * Source of truth for column names — change here and the Python file together.
 */

// ── Column name constants ────────────────────────────────────────────────────
// Insert columns
export const COL_STOCK_ID = 'stock_id'
export const COL_MODEL_NAME = 'model_name'
export const COL_GENERATED_AT = 'generated_at'
export const COL_HORIZON = 'horizon'
export const COL_DIRECTION_ACCURACY = 'direction_accuracy'
export const COL_FORECAST_DATA = 'forecast_data'
export const COL_ENTRY_PRICE = 'entry_price'
export const COL_STOP_LOSS = 'stop_loss'
export const COL_TARGET1 = 'target1'
export const COL_TARGET2 = 'target2'
export const COL_TRADE_SIGNAL = 'trade_signal'
export const COL_FEATURE_VERSION = 'feature_version'
export const COL_SIGNAL_RAW = 'signal_raw'

// Verify-update columns
export const COL_PREDICTED_DIRECTION = 'predicted_direction'
export const COL_PREDICTED_PRICE = 'predicted_price'
export const COL_ACTUAL_DIRECTION = 'actual_direction'
export const COL_ACTUAL_PRICE = 'actual_price'
export const COL_DIRECTION_CORRECT = 'direction_correct'
export const COL_PRICE_ERROR_PCT = 'price_error_pct'
export const COL_MARKET_RISK_LEVEL = 'market_risk_level'
export const COL_MARKET_RISK_SCORE = 'market_risk_score'
export const COL_ACTUAL_RETURN_PCT = 'actual_return_pct'
export const COL_TRADE_OUTCOME = 'trade_outcome'
export const COL_TRADE_PNL_PCT = 'trade_pnl_pct'
export const COL_TRADE_PNL_R = 'trade_pnl_r'
export const COL_MAX_FAVORABLE_PCT = 'max_favorable_pct'
export const COL_MAX_ADVERSE_PCT = 'max_adverse_pct'
export const COL_VERIFIED_AT = 'verified_at'

// ── Verify update SQL (shared with verify_service.py) ────────────────────────
export const UPDATE_VERIFY_SQL = `
UPDATE predictions SET
  ${COL_PREDICTED_DIRECTION} = ?,
  ${COL_PREDICTED_PRICE}     = ?,
  ${COL_ACTUAL_DIRECTION}    = ?,
  ${COL_ACTUAL_PRICE}        = ?,
  ${COL_DIRECTION_CORRECT}   = ?,
  ${COL_PRICE_ERROR_PCT}     = ?,
  ${COL_MARKET_RISK_LEVEL}   = ?,
  ${COL_MARKET_RISK_SCORE}   = ?,
  ${COL_ACTUAL_RETURN_PCT}   = ?,
  ${COL_TRADE_OUTCOME}       = ?,
  ${COL_TRADE_PNL_PCT}       = ?,
  ${COL_TRADE_PNL_R}         = ?,
  ${COL_MAX_FAVORABLE_PCT}   = ?,
  ${COL_MAX_ADVERSE_PCT}     = ?,
  ${COL_VERIFIED_AT}         = datetime('now')
WHERE id = ?
`.trim()

// ── Shared types ─────────────────────────────────────────────────────────────

export type TradeOutcome = 'expired' | 'hit_target1' | 'hit_target2' | 'hit_stop'
export type Direction = 'up' | 'down' | 'neutral'

export interface Bar {
  date: string
  open: number
  high: number
  low: number
  close: number
}

export interface ForecastEntry {
  forecast: number
  lower95?: number
  upper95?: number
}

export interface ForecastData {
  signal?: string
  forecasts?: ForecastEntry[]
  arf_features?: number[]
}

export interface TradeSimulationResult {
  outcome: TradeOutcome
  tradePnlPct: number
  tradePnlR: number
  maxFavorable: number
  maxAdverse: number
}
