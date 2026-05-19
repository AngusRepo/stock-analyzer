-- Performance indexes for hot dashboard / OBS / recommendation paths.
-- Scope: read-heavy UI and control-plane queries only. Avoid broad duplicate indexes
-- that would increase D1 write amplification without helping known hot paths.
-- The zz prefix keeps this after older table-creation migrations in simple
-- filename-ordered apply scripts.

-- Daily recommendations are read by date, rank, score, lane, and symbol across
-- Dashboard/Bot/OBS cards.
CREATE INDEX IF NOT EXISTS idx_rec_date_rank_score
  ON daily_recommendations(date, rank, score DESC);

CREATE INDEX IF NOT EXISTS idx_rec_date_signal_score
  ON daily_recommendations(date, has_buy_signal, score DESC);

CREATE INDEX IF NOT EXISTS idx_rec_symbol_date
  ON daily_recommendations(symbol, date DESC);

-- Prediction coverage and per-model vote queries filter by business date and
-- group/order by model name. Recommendation card joins also need the latest
-- prediction per stock/model/date.
CREATE INDEX IF NOT EXISTS idx_pred_date_model_stock
  ON predictions(prediction_date, model_name, stock_id);

CREATE INDEX IF NOT EXISTS idx_pred_date_stock_model_generated
  ON predictions(prediction_date, stock_id, model_name, generated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_pred_stock_generated
  ON predictions(stock_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pred_model_verified_date
  ON predictions(model_name, verified_at, prediction_date);

-- Data quality freshness checks and table stats are date-first scans. Existing
-- stock-first indexes remain for detail pages.
CREATE INDEX IF NOT EXISTS idx_prices_date_stock
  ON stock_prices(date, stock_id);

CREATE INDEX IF NOT EXISTS idx_ti_date_stock
  ON technical_indicators(date, stock_id);

CREATE INDEX IF NOT EXISTS idx_chip_date_symbol
  ON chip_data(date, symbol);

-- Model health / adaptive engine reads model accuracy by period.
CREATE INDEX IF NOT EXISTS idx_model_acc_period_model
  ON model_accuracy(period, model_name);

-- Sector/theme pages and daily reports read latest date + classification ordered
-- by total flow.
CREATE INDEX IF NOT EXISTS idx_sector_flow_date_class_total
  ON sector_flow(date, classification, total_net DESC);

CREATE INDEX IF NOT EXISTS idx_sector_flow_stocks_date_theme_class_net
  ON sector_flow_stocks(date, theme, classification, net_amount DESC);

-- Screener evidence drilldown filters latest run + selected symbols/stages.
CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_run_symbol_stage
  ON screener_funnel_items(run_id, symbol, stage, created_at);

-- Paper dashboard and audit reads are account-first with side/status filters.
CREATE INDEX IF NOT EXISTS idx_paper_orders_account_side_created
  ON paper_orders(account_id, side, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_positions_account_symbol_shares
  ON paper_positions(account_id, symbol, shares);

CREATE INDEX IF NOT EXISTS idx_paper_execution_events_account_created
  ON paper_execution_events(account_id, created_at DESC);
