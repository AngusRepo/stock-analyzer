-- StockVision Cloudflare D1 Schema
-- Converted from MySQL (drizzle/mysql) to SQLite (D1)

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id   TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  avatar      TEXT,
  role        TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  -- 'approved' | 'pending' | 'rejected'
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('approved','pending','rejected')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_login  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);

CREATE TABLE IF NOT EXISTS stocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  market     TEXT NOT NULL DEFAULT 'TWSE' CHECK(market IN ('TWSE','OTC','US')),
  sector     TEXT,
  in_current_watchlist  INTEGER NOT NULL DEFAULT 1,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stocks_symbol ON stocks(symbol);

CREATE TABLE IF NOT EXISTS stock_prices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id   INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  close      REAL,
  adj_close  REAL,
  volume     INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_prices_stock_date ON stock_prices(stock_id, date);

CREATE TABLE IF NOT EXISTS technical_indicators (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  ma5          REAL, ma10 REAL, ma20 REAL, ma60 REAL,
  rsi14        REAL,
  macd         REAL, macd_signal REAL, macd_hist REAL,
  atr14        REAL,
  plus_di14    REAL, minus_di14 REAL, adx14 REAL,
  parabolic_sar REAL,
  cci20        REAL,
  volume_weighted_rsi14 REAL,
  volume_momentum_divergence_13_27_10 REAL,
  squeeze_on REAL,
  squeeze_release REAL,
  squeeze_momentum REAL,
  obv_temperature_60 REAL,
  adaptive_rsi_midline_50 REAL,
  adaptive_rsi_upper_50 REAL,
  adaptive_rsi_lower_50 REAL,
  adaptive_rsi_overbought REAL,
  adaptive_rsi_oversold REAL,
  bb_upper     REAL, bb_mid REAL, bb_lower REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ti_stock_date ON technical_indicators(stock_id, date);

CREATE TABLE IF NOT EXISTS financials (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id           INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  period             TEXT NOT NULL,
  period_type        TEXT NOT NULL CHECK(period_type IN ('monthly','quarterly','annual')),
  revenue            INTEGER,
  revenue_growth_yoy REAL,
  eps                REAL,
  roe                REAL,
  pe                 REAL,
  pb                 REAL,
  dividend_yield     REAL,
  dividend_per_share REAL,
  book_value_per_share REAL,
  price_at_record    REAL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, period)
);
CREATE INDEX IF NOT EXISTS idx_fin_stock_period ON financials(stock_id, period);

CREATE TABLE IF NOT EXISTS canonical_fundamental_features (
  stock_id                    TEXT NOT NULL,
  period                      TEXT NOT NULL,
  market_segment              TEXT,
  report_date                 TEXT,
  available_date              TEXT,
  revenue_growth_yoy          REAL,
  gross_margin                REAL,
  operating_margin            REAL,
  roe                         REAL,
  eps                         REAL,
  pe                          REAL,
  pb                          REAL,
  dividend_yield              REAL,
  revenue                     REAL,
  debt_ratio                  REAL,
  current_ratio               REAL,
  operating_cash_flow         REAL,
  industry_quality_percentile REAL,
  roa                         REAL,
  roa_comprehensive           REAL,
  roe_comprehensive           REAL,
  ebitda                      REAL,
  free_cash_flow              REAL,
  ebitda_margin               REAL,
  pretax_margin               REAL,
  net_margin                  REAL,
  non_operating_income_revenue_ratio REAL,
  berry_ratio                 REAL,
  operating_expense_ratio     REAL,
  sales_expense_ratio         REAL,
  admin_expense_ratio         REAL,
  rd_expense_ratio            REAL,
  cash_flow_ratio             REAL,
  tax_rate                    REAL,
  sales_per_share             REAL,
  operating_income_per_share  REAL,
  comprehensive_income_per_share REAL,
  liabilities_to_equity       REAL,
  equity_to_assets            REAL,
  gross_margin_growth         REAL,
  operating_income_growth     REAL,
  pretax_income_growth        REAL,
  net_income_growth           REAL,
  recurring_income_growth     REAL,
  total_assets_growth         REAL,
  equity_growth               REAL,
  quick_ratio                 REAL,
  interest_expense_ratio      REAL,
  total_asset_turnover        REAL,
  receivables_turnover        REAL,
  inventory_turnover          REAL,
  fixed_asset_turnover        REAL,
  equity_turnover             REAL,
  operating_income            REAL,
  net_income                  REAL,
  financial_cost              REAL,
  operating_expenses          REAL,
  cash_flow_per_share         REAL,
  pretax_income_per_share     REAL,
  property_plant_equipment    REAL,
  working_capital             REAL,
  current_liabilities         REAL,
  operating_cash_flow_statement REAL,
  non_current_assets          REAL,
  cash_and_cash_equivalents_increase_decrease REAL,
  other_payables              REAL,
  capital_amount              REAL,
  common_stock_capital        REAL,
  preferred_stock_capital     REAL,
  total_assets                REAL,
  total_liabilities           REAL,
  equity_parent               REAL,
  source                      TEXT NOT NULL,
  lineage_json                TEXT,
  as_of_date                  TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(stock_id, period, source)
);
CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_symbol_date
  ON canonical_fundamental_features(stock_id, available_date DESC, period DESC);

CREATE TABLE IF NOT EXISTS chip_data (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT NOT NULL,
  date           TEXT NOT NULL,
  foreign_buy    INTEGER, foreign_sell INTEGER, foreign_net INTEGER,
  trust_buy      INTEGER, trust_sell   INTEGER, trust_net   INTEGER,
  dealer_buy     INTEGER, dealer_sell  INTEGER, dealer_net  INTEGER,
  margin_balance INTEGER,
  short_balance  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_chip_symbol_date ON chip_data(symbol, date);

CREATE TABLE IF NOT EXISTS news (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  summary      TEXT,
  url          TEXT,
  source       TEXT,
  sentiment    TEXT DEFAULT 'neutral' CHECK(sentiment IN ('positive','neutral','negative')),
  published_at TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, url)
);
CREATE INDEX IF NOT EXISTS idx_news_stock_date ON news(stock_id, published_at);

CREATE TABLE IF NOT EXISTS predictions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id           INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  model_name         TEXT NOT NULL,
  generated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  prediction_date    TEXT,              -- pipeline business date; do not infer from generated_at
  horizon            INTEGER DEFAULT 30,
  rmse               REAL, mape REAL, direction_accuracy REAL,
  best_model         INTEGER DEFAULT 0,
  forecast_data      TEXT, -- JSON string
  entry_price        REAL, stop_loss REAL,
  target1            REAL, target2 REAL,
  trade_signal       TEXT DEFAULT 'hold' CHECK(trade_signal IN ('buy','sell','hold')),
  -- 預測驗證欄位（收盤後回填）
  predicted_direction TEXT,              -- 預測方向：'up' | 'down' | 'neutral'
  predicted_price     REAL,              -- 預測的 5 日後價格
  actual_direction    TEXT,              -- 實際方向（收盤後驗證）
  actual_price        REAL,              -- 實際 5 日後收盤價
  direction_correct   INTEGER,           -- 1=預測對, 0=預測錯, NULL=待驗證
  price_error_pct     REAL,              -- 預測價格誤差 %
  verified_at         TEXT,              -- 驗證時間
  -- 市況記錄（驗證時回填，供「市況分析」功能使用）
  market_risk_level   TEXT,              -- 預測當時的大盤風險等級 'low'|'medium'|'high'|'extreme'
  market_risk_score   INTEGER,           -- 預測當時的大盤風險分數 0~100
  -- 特徵版本標記（特徵集更新後，舊/新 predictions 分開統計）
  feature_version     TEXT,              -- e.g. "v1" | "v2_market_env" | "v3_catboost"
  -- 交易模擬損益（依建議 entry/stop/target 計算，驗證模型估價品質）
  actual_return_pct   REAL,              -- 5日實際報酬率（不管有沒有入場）
  trade_outcome       TEXT,              -- 'hit_target1'|'hit_stop'|'expired'|'hit_target2'|NULL
  trade_pnl_pct       REAL,              -- 若依建議入場的模擬損益 %（正=獲利，負=虧損）
  trade_pnl_r         REAL,              -- 損益以 R 倍數表示（1R = 1 個停損距離）
  max_favorable_pct   REAL,              -- 持倉期間最大有利波動（MAE/MFE 分析用）
  max_adverse_pct     REAL,              -- 持倉期間最大不利波動
  verification_label_schema_version TEXT,
  verification_label_entry_price REAL,
  verification_label_end_date TEXT,
  verification_label_known_date TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pred_stock    ON predictions(stock_id, model_name);
CREATE INDEX IF NOT EXISTS idx_predictions_business_date ON predictions(prediction_date, stock_id, model_name);
CREATE INDEX IF NOT EXISTS idx_pred_verify   ON predictions(stock_id, verified_at);
CREATE INDEX IF NOT EXISTS idx_pred_unverify ON predictions(stock_id, direction_correct) WHERE direction_correct IS NULL;

CREATE TABLE IF NOT EXISTS s12_replay_trade_outcomes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                TEXT NOT NULL,
  market                TEXT,
  trade_date            TEXT NOT NULL,
  assessment_state      TEXT,
  setup_id              TEXT,
  entry_ms              INTEGER,
  exit_ms               INTEGER,
  entry_price           REAL,
  stop_price            REAL,
  target1_price         REAL,
  target2_price         REAL,
  target3_price         REAL,
  exit_price            REAL,
  pnl_pct               REAL,
  trade_pnl_r           REAL,
  max_favorable_pct     REAL,
  max_adverse_pct       REAL,
  bars_to_exit          INTEGER,
  exit_reason           TEXT,
  sample_eligible       INTEGER NOT NULL DEFAULT 0,
  source                TEXT NOT NULL DEFAULT 's12_intraday_structure_replay_v1',
  detail_json           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, trade_date, setup_id)
);
CREATE INDEX IF NOT EXISTS idx_s12_replay_trade_outcomes_date
  ON s12_replay_trade_outcomes(trade_date DESC, sample_eligible, symbol);

CREATE TABLE IF NOT EXISTS s12_structure_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date            TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 's12_intraday_structure_v1',
  side                  TEXT,
  state                 TEXT,
  ready                 INTEGER NOT NULL DEFAULT 0,
  invalidated           INTEGER NOT NULL DEFAULT 0,
  setup_id              TEXT,
  entry_price           REAL,
  chase_ceiling         REAL,
  structure_stop        REAL,
  target1_price         REAL,
  target2_price         REAL,
  target3_price         REAL,
  target4_price         REAL,
  demand_zone_low       REAL,
  demand_zone_high      REAL,
  supply_zone_low       REAL,
  supply_zone_high      REAL,
  detail                TEXT,
  entry_context_json    TEXT,
  exit_plan_json        TEXT,
  raw_json              TEXT,
  pending_run_id        TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trade_date, symbol, source)
);
CREATE INDEX IF NOT EXISTS idx_s12_structure_snapshots_date_symbol
  ON s12_structure_snapshots(trade_date DESC, symbol);

CREATE TABLE IF NOT EXISTS s12_tw_calibration_runs (
  run_id               TEXT PRIMARY KEY,
  run_date             TEXT NOT NULL,
  cadence              TEXT NOT NULL,
  status               TEXT NOT NULL,
  scopes_seen          INTEGER NOT NULL DEFAULT 0,
  artifacts_written    INTEGER NOT NULL DEFAULT 0,
  summary_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS s12_tw_calibration_artifacts (
  artifact_id          TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL,
  status               TEXT NOT NULL,
  cadence              TEXT NOT NULL,
  market_segment       TEXT NOT NULL,
  alpha_bucket         TEXT,
  entry_time_bucket    TEXT,
  policy_json          TEXT NOT NULL,
  exit_json            TEXT NOT NULL,
  validation_start     TEXT NOT NULL,
  validation_end       TEXT NOT NULL,
  sample_count         INTEGER NOT NULL,
  date_count           INTEGER NOT NULL,
  metrics_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at          TEXT,
  superseded_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_s12_tw_calibration_active
  ON s12_tw_calibration_artifacts(
    status,
    superseded_at,
    market_segment,
    alpha_bucket,
    entry_time_bucket,
    approved_at DESC
  );

CREATE TABLE IF NOT EXISTS state_space_shadow_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'modal_state_space_shadow',
  model_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  stock_id INTEGER,
  horizon INTEGER,
  forecast_pct REAL,
  up_prob REAL,
  confidence REAL,
  direction TEXT,
  model_version TEXT,
  n_used INTEGER,
  degraded INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
  error TEXT,
  diagnostics_json TEXT,
  overlay_json TEXT NOT NULL,
  callback_json TEXT,
  function_call_id TEXT,
  elapsed_s REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_date, run_id, model_name, symbol)
);
CREATE INDEX IF NOT EXISTS idx_state_space_shadow_run
  ON state_space_shadow_results(run_date, run_id);
CREATE INDEX IF NOT EXISTS idx_state_space_shadow_model_symbol
  ON state_space_shadow_results(model_name, symbol, run_date);
CREATE INDEX IF NOT EXISTS idx_state_space_shadow_errors
  ON state_space_shadow_results(run_date, model_name, error, fallback_reason);

-- 個股模型累積準確率（每次驗證後更新，ensemble 用這個當權重）
CREATE TABLE IF NOT EXISTS model_accuracy (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  model_name   TEXT NOT NULL,
  period       TEXT NOT NULL DEFAULT 'all',  -- 'all' | '30d' | '90d'
  total_count  INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  accuracy     REAL NOT NULL DEFAULT 0.5,    -- correct / total
  avg_price_error REAL,                      -- 平均價格誤差 %
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  -- 市況分析欄位（資料量足夠後啟用）
  accuracy_in_low_risk    REAL,   -- 低風險市況準確率
  accuracy_in_high_risk   REAL,   -- 高風險市況準確率
  count_low_risk          INTEGER DEFAULT 0,
  count_high_risk         INTEGER DEFAULT 0,
  -- 盈虧品質指標（比純準確率更重要）
  avg_win_pct       REAL,         -- 預測正確時平均實際報酬 %
  avg_loss_pct      REAL,         -- 預測錯誤時平均實際虧損 %（負數）
  profit_factor     REAL,         -- 毛利 / 毛損，>1 代表策略有正期望值
  avg_trade_pnl     REAL,         -- 依建議入場的平均每筆模擬損益 %
  avg_trade_pnl_r   REAL,         -- 平均每筆損益（R 倍數）
  hit_target_rate   REAL,         -- 達到 target1 的比率
  hit_stop_rate     REAL,         -- 觸碰停損的比率
  expectancy        REAL,         -- 期望值 = (勝率×平均獲利) - (敗率×平均虧損)
  UNIQUE(stock_id, model_name, period)
);
CREATE INDEX IF NOT EXISTS idx_model_acc ON model_accuracy(stock_id, model_name);

-- 個股分析記憶（LLM RAG 用）
CREATE TABLE IF NOT EXISTS stock_memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id   INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL,  -- 'pattern' | 'signal_result' | 'key_level'
  content    TEXT NOT NULL,   -- 記憶內容
  confidence REAL DEFAULT 0.5, -- 0~1，基於樣本數
  sample_count INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_stock ON stock_memories(stock_id, memory_type);

CREATE TABLE IF NOT EXISTS watchlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_id    INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  cost_price  REAL,
  shares      REAL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, stock_id)
);
CREATE INDEX IF NOT EXISTS idx_wl_user_stock ON watchlist(user_id, stock_id);

CREATE TABLE IF NOT EXISTS factor_scores (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id         INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  date             TEXT NOT NULL,
  momentum1m       REAL, momentum3m REAL, momentum6m REAL,
  value_pe         REAL, value_pb REAL, value_dy REAL,
  quality_roe      REAL, quality_growth REAL,
  volatility       REAL, size REAL,
  z_momentum       REAL, z_value REAL, z_quality REAL,
  z_volatility     REAL, z_size REAL,
  composite_score  REAL,
  quantile         INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);

CREATE TABLE IF NOT EXISTS risk_metrics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id           INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  period             TEXT NOT NULL DEFAULT '1y',
  sharpe_ratio       REAL, sortino_ratio REAL,
  beta               REAL, max_drawdown REAL,
  var95              REAL, cvar95 REAL,
  annual_return      REAL, annual_volatility REAL,
  calculated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, period)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_id         INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  rule_type        TEXT NOT NULL,
  threshold        REAL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  last_triggered   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alert_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alert_rules(is_active);

-- 大盤風險指標（每日計算）
CREATE TABLE IF NOT EXISTS market_risk (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL UNIQUE,
  -- 恐慌指標
  vix             REAL,              -- CBOE VIX 恐慌指數
  vix_level       TEXT,              -- low/normal/elevated/high/extreme
  -- 台股波動率
  twii_close      REAL,              -- 加權指數收盤
  twii_vol20      REAL,              -- 20日歷史波動率（年化）
  twii_ma20       REAL,              -- 20日均線
  twii_bias       REAL,              -- 乖離率 %
  -- 籌碼訊號
  foreign_consecutive_sell INTEGER, -- 外資連續賣超天數（負數=連續買超）
  foreign_net_5d  REAL,              -- 外資近5日累計買賣超（億）
  margin_ratio    REAL,              -- 融資使用率 %
  -- 跌停異常
  limit_down_count INTEGER,          -- 當日跌停家數
  limit_down_pct   REAL,             -- 跌停家數佔比 %
  -- 綜合風險評分
  risk_score      INTEGER,           -- 0-100，越高越危險
  risk_level      TEXT,              -- green/yellow/orange/red/black
  risk_summary    TEXT,              -- AI 生成的文字說明
  calculated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_market_risk_date ON market_risk(date);


-- 交易模擬績效彙總（供前端儀表板用，每次驗證後更新）
CREATE TABLE IF NOT EXISTS trade_performance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  model_name   TEXT NOT NULL,
  period       TEXT NOT NULL DEFAULT 'all',  -- 'all' | '30d' | '90d'
  -- 基本計數
  total_trades    INTEGER DEFAULT 0,
  win_trades      INTEGER DEFAULT 0,
  loss_trades     INTEGER DEFAULT 0,
  -- 損益統計
  total_pnl_pct   REAL,   -- 累計模擬損益 %
  avg_win_pct     REAL,   -- 平均獲利 %
  avg_loss_pct    REAL,   -- 平均虧損 %（負數）
  max_win_pct     REAL,   -- 最大單筆獲利 %
  max_loss_pct    REAL,   -- 最大單筆虧損 %
  profit_factor   REAL,   -- 毛利 / 毛損
  expectancy      REAL,   -- 期望值
  -- R 倍數統計
  avg_pnl_r       REAL,   -- 平均損益 R 倍數
  -- 出場分佈
  hit_target1_count INTEGER DEFAULT 0,
  hit_target2_count INTEGER DEFAULT 0,
  hit_stop_count    INTEGER DEFAULT 0,
  expired_count     INTEGER DEFAULT 0,  -- 5天到期未觸碰停損/目標
  -- MAE/MFE
  avg_mfe         REAL,   -- 平均最大有利波動
  avg_mae         REAL,   -- 平均最大不利波動
  last_updated    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, model_name, period)
);
CREATE INDEX IF NOT EXISTS idx_trade_perf ON trade_performance(stock_id, model_name);


-- 系統運行日誌（Cron 成功/失敗記錄，供前端 SystemStatusBar 用）
CREATE TABLE IF NOT EXISTS system_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  level       TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
  cron_name   TEXT NOT NULL,
  message     TEXT NOT NULL,
  meta        TEXT,                          -- JSON 附加資訊
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_system_logs ON system_logs(created_at DESC);


-- OBS 統一事件 audit surface（P8 observability contract）
CREATE TABLE IF NOT EXISTS observability_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK(severity IN ('ok','info','warn','error')),
  domain      TEXT NOT NULL,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  owner       TEXT NOT NULL,
  impact      TEXT,
  next_action TEXT,
  evidence    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_observability_events_date ON observability_events(date, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_events_domain ON observability_events(domain, created_at DESC);


-- 聊天對話持久化
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  stock_id    INTEGER REFERENCES stocks(id) ON DELETE CASCADE,
  title       TEXT,                         -- 自動摘要（第一則問題前 30 字）
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions ON chat_sessions(user_id, stock_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages ON chat_messages(session_id, created_at);

-- 警報觸發紀錄（前端 badge 讀取，讓用戶知道有警報發生）
CREATE TABLE IF NOT EXISTS alert_notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_id     INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  stock_symbol TEXT NOT NULL,
  stock_name   TEXT,
  rule_type    TEXT NOT NULL,
  threshold    REAL,
  triggered_price REAL,
  is_read      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user_read ON alert_notifications(user_id, is_read);

-- ─── Schema Migration：所有欄位已整合進 CREATE TABLE，無需 ALTER ────────────

-- ─── 每日選股推薦 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_recommendations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,           -- 推薦日期 YYYY-MM-DD
  stock_id     INTEGER REFERENCES stocks(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  name         TEXT NOT NULL,
  sector       TEXT,                    -- 所屬族群
  rank         INTEGER NOT NULL,        -- 當日排名（1=最強）
  score        REAL NOT NULL,           -- 綜合分數 0-100
  signal       TEXT,                    -- ML 訊號：BUY / STRONG_BUY / HOLD
  confidence   REAL,                    -- ML 信心度
  -- 推薦理由（LLM 生成）
  reason       TEXT NOT NULL,           -- 推薦理由（中文，500字內）
  watch_points TEXT,                    -- 需注意的因素（JSON array of strings）
  has_buy_signal INTEGER DEFAULT 0,     -- 是否有買進訊號
  -- 量化依據（快照）
  current_price REAL,
  foreign_net_5d REAL,                  -- 外資近5日累計
  trust_net_5d   REAL,                  -- 投信近5日累計
  rsi14         REAL,
  macd_hist     REAL,
  sector_rank   TEXT,                   -- 族群相對強弱排名
  chip_score    REAL DEFAULT 0,          -- 籌碼分數 (0-40)
  tech_score    REAL DEFAULT 0,          -- 技術分數 (0-30)
  momentum_score REAL DEFAULT 0,         -- Screener 動能/成交量分數 (0-20)
  ml_score      REAL DEFAULT 0,          -- ML 分數 (0-30)
  market_segment TEXT,
  recommendation_lane TEXT DEFAULT 'tradable',
  eligible_for_ml INTEGER DEFAULT 1,
  eligible_for_pending_buy INTEGER DEFAULT 1,
  alpha_context TEXT,
  alpha_allocation TEXT,
  ml_vote_summary TEXT,
  score_components TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, stock_id)
);
CREATE INDEX IF NOT EXISTS idx_rec_date ON daily_recommendations(date DESC);

-- ─── 族群資金流向 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sector_flow (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  sector          TEXT NOT NULL,
  foreign_net     REAL,     -- 外資淨買賣（億）
  trust_net       REAL,     -- 投信淨買賣（億）
  total_net       REAL,     -- 合計法人買賣（億）
  turnover_value  REAL,
  turnover_share  REAL,
  turnover_share_delta REAL,
  avg_rsi         REAL,     -- 族群平均 RSI
  avg_momentum_5d REAL,     -- 族群平均5日動能
  stock_count     INTEGER,  -- 族群股票數
  up_count        INTEGER,  -- 上漲家數
  llm_summary     TEXT,     -- LLM 生成的族群分析
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  classification TEXT DEFAULT 'industry',
  rs_ratio        REAL,
  rs_momentum     REAL,
  quadrant        TEXT,
  rotation_velocity REAL,
  rotation_acceleration REAL,
  quadrant_age    INTEGER,
  transition_path TEXT,
  rotation_score  REAL,
  rotation_regime TEXT,
  rotation_hysteresis TEXT,
  rotation_window INTEGER,
  rrg_tail_json   TEXT,
  UNIQUE(date, sector, classification)
);
CREATE INDEX IF NOT EXISTS idx_sector_flow_date ON sector_flow(date DESC, total_net DESC);
CREATE INDEX IF NOT EXISTS idx_sector_flow_rotation_regime ON sector_flow(date, classification, rotation_regime);
CREATE INDEX IF NOT EXISTS idx_sector_flow_rotation_score ON sector_flow(date, classification, rotation_score DESC);

CREATE TABLE IF NOT EXISTS screener_funnel_runs (
  run_id          TEXT PRIMARY KEY,
  date            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'success',
  universe_count  INTEGER DEFAULT 0,
  candidate_count INTEGER DEFAULT 0,
  final_count     INTEGER DEFAULT 0,
  emerging_count  INTEGER DEFAULT 0,
  metadata        TEXT,
  debug_log       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_screener_funnel_runs_date ON screener_funnel_runs(date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS screener_funnel_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  date          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  name          TEXT,
  stage         TEXT NOT NULL,
  decision      TEXT NOT NULL,
  reason_code   TEXT NOT NULL,
  score_before  REAL,
  score_after   REAL,
  rank          INTEGER,
  evidence      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(run_id) REFERENCES screener_funnel_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_run ON screener_funnel_items(run_id, stage, decision);
CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_symbol ON screener_funnel_items(symbol, date DESC);

CREATE TABLE IF NOT EXISTS dataset_snapshots (
  snapshot_id     TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  business_date   TEXT NOT NULL,
  market_segment  TEXT,
  schema_version  TEXT NOT NULL,
  row_count       INTEGER NOT NULL DEFAULT 0,
  checksum        TEXT NOT NULL,
  primary_store   TEXT NOT NULL CHECK(primary_store IN ('d1','gcs','r2')),
  access_tier     TEXT NOT NULL CHECK(access_tier IN ('serving','compute','report','preview','archive')),
  gcs_uri         TEXT,
  r2_key          TEXT,
  producer_run_id TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('pending','ready','failed','expired')),
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_kind_date
  ON dataset_snapshots(kind, business_date DESC, status);
CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_access_date
  ON dataset_snapshots(access_tier, business_date DESC, primary_store);
CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_run
  ON dataset_snapshots(producer_run_id, kind);

CREATE TABLE IF NOT EXISTS model_artifact_registry (
  artifact_id                 TEXT PRIMARY KEY,
  model_name                  TEXT NOT NULL,
  version                     TEXT NOT NULL,
  candidate_type              TEXT NOT NULL CHECK(candidate_type IN ('monthly_release','weekly_drift','manual_hotfix','model_family_shadow','research_benchmark','timesfm_l175_l2_feature_release','unknown')),
  state                       TEXT NOT NULL CHECK(state IN (
    'registered',
    'registration_failed',
    'offline_failed',
    'offline_passed_weak',
    'offline_passed',
    'offline_strong_pass',
    'candidate_selected',
    'shadowing',
    'live_gate_passed',
    'approval_required',
    'approved',
    'production',
    'rejected',
    'archived'
  )),
  artifact_path               TEXT,
  metadata_path               TEXT,
  training_run_id             TEXT,
  training_manifest_path      TEXT,
  trained_from_snapshot       TEXT,
  evaluation_baseline_version TEXT,
  final_compared_to           TEXT,
  feature_policy_version      TEXT,
  checksum                    TEXT,
  source_run_date             TEXT,
  is_monthly                  INTEGER NOT NULL DEFAULT 0,
  offline_gate_status         TEXT NOT NULL DEFAULT 'not_evaluated',
  offline_gate_decision       TEXT NOT NULL DEFAULT 'PENDING',
  offline_gate_failed_gates   TEXT NOT NULL DEFAULT '[]',
  offline_evidence_json       TEXT NOT NULL DEFAULT '{}',
  live_gate_status            TEXT NOT NULL DEFAULT 'not_started',
  live_evidence_json          TEXT NOT NULL DEFAULT '{}',
  promotion_decision          TEXT NOT NULL DEFAULT 'not_evaluated',
  approval_state              TEXT NOT NULL DEFAULT 'not_required',
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_name, version, candidate_type)
);
CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_model_state
  ON model_artifact_registry(model_name, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_candidate_type
  ON model_artifact_registry(candidate_type, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_run
  ON model_artifact_registry(training_run_id, source_run_date);

CREATE TABLE IF NOT EXISTS model_champion_history (
  event_id       TEXT PRIMARY KEY,
  model_name     TEXT NOT NULL,
  version        TEXT NOT NULL,
  artifact_id    TEXT,
  effective_at   TEXT NOT NULL,
  retired_at     TEXT,
  source         TEXT NOT NULL CHECK(source = 'model_champion_history'),
  evidence_grade TEXT NOT NULL CHECK(evidence_grade IN ('exact','bounded','unknown')),
  evidence_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_name, version, effective_at)
);
CREATE INDEX IF NOT EXISTS idx_model_champion_history_asof
  ON model_champion_history(model_name, effective_at, retired_at);

CREATE TABLE IF NOT EXISTS model_champion_pointers (
  model_name                  TEXT PRIMARY KEY,
  champion_version            TEXT NOT NULL,
  champion_artifact_id        TEXT,
  rollback_version            TEXT,
  rollback_artifact_id        TEXT,
  promoted_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promotion_reason            TEXT,
  promotion_evidence_json     TEXT NOT NULL DEFAULT '{}',
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_model_champion_pointers_updated
  ON model_champion_pointers(updated_at DESC);

CREATE TABLE IF NOT EXISTS allocator_ev_feature_snapshots (
  snapshot_date               TEXT NOT NULL,
  stock_id                    INTEGER NOT NULL,
  symbol                      TEXT NOT NULL,
  forecast_data               TEXT,
  score                       REAL,
  score_components            TEXT,
  alpha_context               TEXT,
  alpha_allocation            TEXT NOT NULL,
  market_heat_expected_return REAL,
  market_segment              TEXT,
  recommendation_lane         TEXT,
  snapshot_source             TEXT NOT NULL DEFAULT 'allocator_ev_asof_backfill_v2',
  l4_model_version            TEXT,
  s12_source                  TEXT,
  as_of_guard                 TEXT NOT NULL,
  source_recommendation_date  TEXT,
  lineage_cohort_id           TEXT,
  generation_mode             TEXT NOT NULL DEFAULT 'native',
  model_set_signature         TEXT,
  target_semantic_version     TEXT,
  generated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_date, stock_id, snapshot_source)
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshots_date
  ON allocator_ev_feature_snapshots(snapshot_date, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshots_symbol
  ON allocator_ev_feature_snapshots(symbol, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS allocator_ev_snapshot_runs (
  run_id TEXT PRIMARY KEY,
  snapshot_date TEXT NOT NULL,
  snapshot_source TEXT NOT NULL,
  as_of_guard TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing','ready','failed')),
  expected_rows INTEGER NOT NULL DEFAULT 0,
  staged_rows INTEGER NOT NULL DEFAULT 0,
  published_rows INTEGER NOT NULL DEFAULT 0,
  native_lineage_rows INTEGER NOT NULL DEFAULT 0,
  reconstructed_lineage_rows INTEGER NOT NULL DEFAULT 0,
  rejected_lineage_rows INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshot_runs_date_status
  ON allocator_ev_snapshot_runs(snapshot_date DESC, snapshot_source, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS allocator_ev_feature_snapshot_staging (
  run_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  stock_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  forecast_data TEXT,
  score REAL,
  score_components TEXT,
  alpha_context TEXT,
  alpha_allocation TEXT NOT NULL,
  market_heat_expected_return REAL,
  market_segment TEXT,
  recommendation_lane TEXT,
  snapshot_source TEXT NOT NULL,
  l4_model_version TEXT,
  s12_source TEXT,
  as_of_guard TEXT NOT NULL,
  source_recommendation_date TEXT,
  lineage_cohort_id TEXT,
  generation_mode TEXT NOT NULL DEFAULT 'native',
  model_set_signature TEXT,
  target_semantic_version TEXT,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, stock_id),
  FOREIGN KEY (run_id) REFERENCES allocator_ev_snapshot_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshot_staging_run
  ON allocator_ev_feature_snapshot_staging(run_id, snapshot_date, stock_id);

CREATE TABLE IF NOT EXISTS active8_oof_cohorts (
  cohort_id TEXT PRIMARY KEY,
  generation_mode TEXT NOT NULL CHECK(generation_mode = 'purged_oof'),
  status TEXT NOT NULL CHECK(status IN ('building','ready','failed','retired')),
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  model_set_signature TEXT NOT NULL,
  expected_models INTEGER NOT NULL DEFAULT 8,
  expected_folds INTEGER NOT NULL,
  completed_folds INTEGER NOT NULL DEFAULT 0,
  prediction_rows INTEGER NOT NULL DEFAULT 0,
  prediction_dates INTEGER NOT NULL DEFAULT 0,
  artifact_manifest_path TEXT,
  artifact_manifest_checksum TEXT,
  prediction_storage_mode TEXT NOT NULL DEFAULT 'd1_full_v1',
  parent_cohort_id TEXT,
  parent_manifest_checksum TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS active8_oof_fold_artifacts (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  source_cohort_id TEXT NOT NULL,
  source_manifest_checksum TEXT NOT NULL,
  model_name TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  artifact_rows INTEGER NOT NULL DEFAULT 0,
  prediction_dates INTEGER NOT NULL DEFAULT 0,
  train_start TEXT NOT NULL,
  train_end TEXT NOT NULL,
  test_start TEXT NOT NULL,
  test_end TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, model_name),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(train_end < test_start)
);
CREATE INDEX IF NOT EXISTS idx_active8_oof_fold_artifacts_source
  ON active8_oof_fold_artifacts(source_cohort_id, fold_id, model_name);
CREATE TABLE IF NOT EXISTS active8_oof_materialized_artifacts (
  cohort_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('allocator_ev_snapshots','l4_predictions')),
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  format_version TEXT NOT NULL CHECK(format_version = 'active8-oof-materialized-jsonl-gzip-v1'),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  date_count INTEGER NOT NULL CHECK(date_count >= 0),
  min_date TEXT,
  max_date TEXT,
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes >= 0),
  uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes >= 0),
  source_manifest_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, artifact_kind),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(min_date IS NULL OR max_date IS NULL OR min_date <= max_date)
);
CREATE INDEX IF NOT EXISTS idx_active8_oof_materialized_artifacts_checksum
  ON active8_oof_materialized_artifacts(artifact_checksum);

CREATE TABLE IF NOT EXISTS active8_oof_predictions (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  stock_id INTEGER,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  model_name TEXT NOT NULL,
  raw_score REAL NOT NULL,
  rank_score REAL NOT NULL CHECK(rank_score >= 0.0 AND rank_score <= 1.0),
  target_return REAL NOT NULL,
  label_known_date TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  train_start TEXT NOT NULL,
  train_end TEXT NOT NULL,
  test_start TEXT NOT NULL,
  test_end TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, prediction_date, symbol, market_segment, model_name),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(label_known_date > prediction_date)
);
CREATE INDEX IF NOT EXISTS idx_active8_oof_predictions_cohort_date
  ON active8_oof_predictions(cohort_id, prediction_date, model_name);

CREATE TABLE IF NOT EXISTS allocator_ev_oof_snapshots (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  stock_id INTEGER,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  forecast_data TEXT NOT NULL,
  score REAL,
  score_components TEXT,
  alpha_context TEXT,
  alpha_allocation TEXT NOT NULL,
  market_heat_expected_return REAL,
  recommendation_lane TEXT,
  l4_model_version TEXT,
  s12_source TEXT,
  s12_asof_date TEXT NOT NULL,
  label_known_date TEXT NOT NULL,
  model_set_signature TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  generation_mode TEXT NOT NULL CHECK(generation_mode = 'purged_oof'),
  source_manifest_checksum TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, snapshot_date, symbol, market_segment),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(s12_asof_date <= snapshot_date),
  CHECK(label_known_date > snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_allocator_ev_oof_snapshots_cohort_date
  ON allocator_ev_oof_snapshots(cohort_id, snapshot_date);

CREATE TABLE IF NOT EXISTS l4_oof_predictions (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  expected_return REAL NOT NULL,
  prediction_json TEXT NOT NULL,
  trained_until TEXT NOT NULL,
  model_version TEXT NOT NULL,
  eligible_for_efficacy INTEGER NOT NULL CHECK(eligible_for_efficacy IN (0, 1)),
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, prediction_date, symbol, market_segment),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(trained_until < prediction_date)
);
CREATE INDEX IF NOT EXISTS idx_l4_oof_predictions_cohort_date
  ON l4_oof_predictions(cohort_id, prediction_date);

CREATE TABLE IF NOT EXISTS strategy_spec_registry (
  strategy_id              TEXT NOT NULL,
  version                  TEXT NOT NULL,
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('research','shadow','candidate','active','retired')),
  owner                    TEXT NOT NULL DEFAULT 'strategy',
  alpha_bucket             TEXT NOT NULL,
  family_id                TEXT NOT NULL DEFAULT 'TREND_RECLAIM_CONTINUATION',
  variant_id               TEXT NOT NULL DEFAULT '',
  owner_type               TEXT NOT NULL DEFAULT 'strategy',
  promotion_status         TEXT NOT NULL DEFAULT 'production',
  supported_regimes_json   TEXT NOT NULL DEFAULT '[]',
  thesis                   TEXT NOT NULL,
  thresholds_json          TEXT NOT NULL DEFAULT '{}',
  candidate_policy_json    TEXT NOT NULL DEFAULT '{}',
  risk_notes_json          TEXT NOT NULL DEFAULT '[]',
  source_refs_json         TEXT NOT NULL DEFAULT '[]',
  created_by               TEXT NOT NULL DEFAULT 'p5_strategy_governance',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_id, version)
);
CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_status
  ON strategy_spec_registry(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_bucket
  ON strategy_spec_registry(alpha_bucket, status);
CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_family
  ON strategy_spec_registry(family_id, status);

CREATE TABLE IF NOT EXISTS strategy_decision_log (
  decision_id              TEXT PRIMARY KEY,
  date                     TEXT NOT NULL,
  symbol                   TEXT NOT NULL,
  name                     TEXT,
  strategy_id              TEXT NOT NULL,
  strategy_version         TEXT NOT NULL,
  strategy_status          TEXT NOT NULL,
  alpha_bucket             TEXT NOT NULL,
  matched                  INTEGER NOT NULL DEFAULT 0,
  match_score              REAL,
  reason_code              TEXT NOT NULL,
  context_json             TEXT NOT NULL DEFAULT '{}',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, symbol, strategy_id, strategy_version)
);
CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_date
  ON strategy_decision_log(date DESC, strategy_id, matched);
CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_symbol
  ON strategy_decision_log(symbol, date DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_status
  ON strategy_decision_log(strategy_status, matched, date DESC);

CREATE TABLE IF NOT EXISTS strategy_reward_ledger (
  reward_id                TEXT PRIMARY KEY,
  strategy_id              TEXT NOT NULL,
  strategy_version         TEXT NOT NULL,
  strategy_status          TEXT NOT NULL,
  alpha_bucket             TEXT NOT NULL,
  date_start               TEXT,
  date_end                 TEXT,
  horizon_days             INTEGER NOT NULL DEFAULT 5,
  samples                  INTEGER NOT NULL DEFAULT 0,
  hit_rate                 REAL,
  avg_return_pct           REAL,
  reward_sum               REAL,
  max_drawdown_pct         REAL,
  coverage                 REAL,
  market_segment           TEXT DEFAULT 'all',
  regime                   TEXT DEFAULT 'all',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(strategy_id, strategy_version, horizon_days, market_segment, regime)
);
CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_strategy
  ON strategy_reward_ledger(strategy_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_status
  ON strategy_reward_ledger(strategy_status, samples DESC);

CREATE TABLE IF NOT EXISTS strategy_policy_state (
  policy_id                TEXT PRIMARY KEY,
  version                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('shadow','candidate','active','retired')),
  strategy_weights_json    TEXT NOT NULL DEFAULT '{}',
  threshold_deltas_json    TEXT NOT NULL DEFAULT '{}',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_locks (
  lock_key   TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  run_date   TEXT,
  run_id     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduler_locks_owner_date
  ON scheduler_locks(owner, run_date, created_at DESC);

CREATE TABLE IF NOT EXISTS parameter_candidate_registry (
  candidate_id          TEXT PRIMARY KEY,
  source                TEXT NOT NULL,
  config_hash           TEXT,
  sandbox_id            TEXT,
  cadence               TEXT,
  run_id                TEXT,
  status                TEXT NOT NULL CHECK(status IN (
    'NO_CANDIDATE',
    'SHADOW_COLLECTING',
    'VALIDATION_BLOCKED',
    'EVIDENCE_INSUFFICIENT',
    'NOT_PROMOTION_READY',
    'INFRA_BLOCKED',
    'PROMOTION_READY',
    'APPROVAL_REQUIRED',
    'PROD_ACTIVE'
  )),
  metadata_json         TEXT,
  latest_evidence_json  TEXT,
  promotion_packet_id   TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_parameter_candidate_registry_status
  ON parameter_candidate_registry(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_parameter_candidate_registry_packet
  ON parameter_candidate_registry(promotion_packet_id);

CREATE TABLE IF NOT EXISTS parameter_candidate_evidence (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id          TEXT NOT NULL,
  evidence_type         TEXT NOT NULL,
  decision              TEXT NOT NULL CHECK(decision IN ('PASS','FAIL')),
  evidence_json         TEXT,
  promotion_packet_id   TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_parameter_candidate_evidence_candidate
  ON parameter_candidate_evidence(candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS parameter_candidate_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id          TEXT,
  event_type            TEXT NOT NULL,
  detail_json           TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_parameter_candidate_events_candidate
  ON parameter_candidate_events(candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS entry_model_replay_reports (
  report_id                TEXT PRIMARY KEY,
  version                  TEXT NOT NULL,
  start_date               TEXT NOT NULL,
  end_date                 TEXT NOT NULL,
  loaded_cases             INTEGER NOT NULL DEFAULT 0,
  decision                 TEXT NOT NULL,
  passed                   INTEGER NOT NULL DEFAULT 0,
  failed_gates_json        TEXT NOT NULL DEFAULT '[]',
  summary_json             TEXT NOT NULL DEFAULT '{}',
  promotion_gate_json      TEXT NOT NULL DEFAULT '{}',
  report_json              TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_entry_model_replay_reports_date
  ON entry_model_replay_reports(start_date DESC, end_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entry_model_replay_reports_gate
  ON entry_model_replay_reports(passed, decision, created_at DESC);

-- Multi-LLM Strategy Discovery & Adversarial Audit Lab
-- Research/audit-only control plane. Does not reference production trading tables.

CREATE TABLE IF NOT EXISTS input_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('FEATURES','STRATEGIES','SYSTEM_PROFILE','RUN_MANIFEST')),
  version TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, snapshot_type)
);
CREATE INDEX IF NOT EXISTS idx_input_snapshots_run ON input_snapshots(run_id, snapshot_type);

CREATE TABLE IF NOT EXISTS feature_versions (
  feature_version TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  feature_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS features (
  feature_version TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  definition TEXT NOT NULL,
  data_source_json TEXT NOT NULL DEFAULT '[]',
  availability_lag TEXT NOT NULL,
  earliest_execution TEXT NOT NULL,
  lookback_days INTEGER,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  governance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(feature_version, feature_id)
);
CREATE INDEX IF NOT EXISTS idx_features_family ON features(feature_version, family);

CREATE TABLE IF NOT EXISTS strategy_versions (
  strategy_version TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  strategy_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategies (
  strategy_version TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  card_json TEXT NOT NULL,
  card_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_version, strategy_id)
);
CREATE INDEX IF NOT EXISTS idx_strategies_version ON strategies(strategy_version, strategy_id);

CREATE TABLE IF NOT EXISTS analysis_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN (
    'CREATED','PREFLIGHT','RUNNING','CLOUD_ANALYSIS_COMPLETE','CODEX_HANDOFF_READY',
    'AWAITING_RESULT','RESULT_READY','FAILED_RECOVERABLE','BLOCKED'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  workflow_instance_id TEXT,
  workflow_attempt INTEGER NOT NULL DEFAULT 0,
  feature_version TEXT,
  strategy_version TEXT,
  feature_snapshot_hash TEXT,
  strategy_snapshot_hash TEXT,
  system_profile_hash TEXT,
  input_hash TEXT,
  prompt_set_version TEXT NOT NULL,
  schema_set_version TEXT NOT NULL,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 12,
  current_step TEXT,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  fixture_mode INTEGER NOT NULL DEFAULT 0 CHECK(fixture_mode IN (0,1)),
  error_code TEXT,
  error_detail TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_created_at ON analysis_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON analysis_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED','SKIPPED_REUSED')),
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  model_role TEXT,
  started_at TEXT,
  ended_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  PRIMARY KEY(run_id, step_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_step ON workflow_steps(run_id, step_id);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  artifact_r2_key TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('COMPLETED','INVALIDATED')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_status ON workflow_checkpoints(run_id, status);

CREATE TABLE IF NOT EXISTS model_calls (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  raw_response_r2_key TEXT,
  parsed_response_r2_key TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  repair_count INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_model_calls_run_role ON model_calls(run_id, role);
CREATE INDEX IF NOT EXISTS idx_model_calls_date ON model_calls(started_at, source_type);

CREATE TABLE IF NOT EXISTS feature_clusters (
  run_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  cluster_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, cluster_id)
);

CREATE TABLE IF NOT EXISTS gap_maps (
  run_id TEXT PRIMARY KEY,
  gap_map_json TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hypotheses (
  run_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL,
  search_mode TEXT NOT NULL,
  parent_strategy_id TEXT,
  source_model TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  hypothesis_json TEXT NOT NULL,
  hypothesis_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, hypothesis_id)
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_run_mode ON hypotheses(run_id, search_mode);

CREATE TABLE IF NOT EXISTS candidates (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  search_mode TEXT NOT NULL,
  parent_strategy_id TEXT,
  candidate_hash TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'GENERATED',
  source_model TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id),
  UNIQUE(run_id, candidate_hash)
);
CREATE INDEX IF NOT EXISTS idx_candidates_run_id ON candidates(run_id);

CREATE TABLE IF NOT EXISTS candidate_lineage (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  parent_strategy_id TEXT,
  mutation_type TEXT,
  search_mode TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS static_validation_results (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),
  errors_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  candidate_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS audit_issues (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_ids_json TEXT NOT NULL,
  category TEXT NOT NULL,
  severity_if_true TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  critic_model TEXT NOT NULL,
  critic_confidence REAL NOT NULL,
  cross_exam_status TEXT NOT NULL,
  duplicate_of TEXT,
  issue_json TEXT NOT NULL,
  issue_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, issue_id)
);
CREATE INDEX IF NOT EXISTS idx_audit_issues_run_target ON audit_issues(run_id, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_issues_model ON audit_issues(run_id, critic_model);

CREATE TABLE IF NOT EXISTS cross_examinations (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  status TEXT NOT NULL,
  examination_json TEXT NOT NULL,
  source_model TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, issue_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  artifact_hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  schema_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_type ON artifacts(run_id, artifact_type);

CREATE TABLE IF NOT EXISTS codex_imports (
  import_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  zip_r2_key TEXT,
  error_json TEXT NOT NULL DEFAULT '[]',
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, result_hash),
  UNIQUE(run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_codex_imports_run_id ON codex_imports(run_id);

CREATE TABLE IF NOT EXISTS strategy_verdicts (
  run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS candidate_verdicts (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS issue_verdicts (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  severity TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, issue_id)
);

CREATE TABLE IF NOT EXISTS model_accuracy (
  run_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  role TEXT NOT NULL,
  proposed_count INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  refuted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  unsupported_count INTEGER NOT NULL DEFAULT 0,
  unique_confirmed_count INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, model_id, role)
);

-- Durable Shioaji execution lifecycle. Live submit remains disabled until the
-- controller gateway, runtime ownership and explicit approval gates pass.
CREATE TABLE IF NOT EXISTS broker_execution_intents (
  intent_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy','sell')),
  status TEXT NOT NULL CHECK(status IN ('RESERVED','REVALIDATED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN','BLOCKED')),
  packet_hash TEXT NOT NULL,
  approval_scope TEXT NOT NULL,
  requested_shares INTEGER NOT NULL,
  limit_price REAL NOT NULL,
  intent_json TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_broker_intents_trade_side ON broker_execution_intents(trade_date, side, status);
CREATE INDEX IF NOT EXISTS idx_broker_intents_symbol ON broker_execution_intents(trade_date, symbol, side);

CREATE TABLE IF NOT EXISTS broker_execution_legs (
  leg_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES broker_execution_intents(intent_id),
  leg_key TEXT NOT NULL,
  client_tag TEXT NOT NULL UNIQUE,
  lot_type TEXT NOT NULL CHECK(lot_type IN ('board_lot','odd_lot')),
  requested_shares INTEGER NOT NULL,
  broker_quantity INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RESERVED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN')),
  broker_order_id TEXT,
  submit_attempts INTEGER NOT NULL DEFAULT 0,
  filled_shares INTEGER NOT NULL DEFAULT 0,
  average_fill_price REAL,
  last_error TEXT,
  claimed_at TEXT,
  acknowledged_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(intent_id, leg_key),
  UNIQUE(broker_order_id)
);
CREATE INDEX IF NOT EXISTS idx_broker_legs_recovery ON broker_execution_legs(status, updated_at);

CREATE TABLE IF NOT EXISTS broker_execution_events (
  event_id TEXT PRIMARY KEY,
  intent_id TEXT,
  leg_id TEXT,
  broker_order_id TEXT,
  client_tag TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('INTENT_RESERVED','LEG_CLAIMED','SUBMIT_ACK','SUBMIT_UNKNOWN','SUBMIT_REJECTED','ORDER_CALLBACK','DEAL_CALLBACK','STATUS_RECONCILIATION','CONNECTION_STATE','RECOVERY')),
  event_status TEXT NOT NULL,
  event_time TEXT NOT NULL,
  exchange_sequence TEXT,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(intent_id) REFERENCES broker_execution_intents(intent_id),
  FOREIGN KEY(leg_id) REFERENCES broker_execution_legs(leg_id)
);
CREATE INDEX IF NOT EXISTS idx_broker_events_order_time ON broker_execution_events(broker_order_id, event_time);
CREATE INDEX IF NOT EXISTS idx_broker_events_client_tag ON broker_execution_events(client_tag, event_time);
CREATE INDEX IF NOT EXISTS idx_broker_events_unmatched ON broker_execution_events(broker_order_id, leg_id);

CREATE TABLE IF NOT EXISTS artifact_hard_references (
  reference_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_type, owner_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_hard_references_artifact_active
  ON artifact_hard_references(artifact_id, active);
CREATE INDEX IF NOT EXISTS idx_artifact_hard_references_owner_active
  ON artifact_hard_references(owner_type, owner_id, active);

-- ─────────────────────────────────────────────────────────────────────────────
-- 注意：增量 Schema 變更請使用獨立 migration 檔案執行，不要放在這裡
-- 首次部署：wrangler d1 execute stockvision-db --remote --file=./worker/schema.sql
-- v12 升級：wrangler d1 execute stockvision-db --remote --file=./worker/migration_v12.sql
-- ─────────────────────────────────────────────────────────────────────────────
