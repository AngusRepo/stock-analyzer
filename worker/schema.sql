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
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pred_stock    ON predictions(stock_id, model_name);
CREATE INDEX IF NOT EXISTS idx_predictions_business_date ON predictions(prediction_date, stock_id, model_name);
CREATE INDEX IF NOT EXISTS idx_pred_verify   ON predictions(stock_id, verified_at);
CREATE INDEX IF NOT EXISTS idx_pred_unverify ON predictions(stock_id, direction_correct) WHERE direction_correct IS NULL;

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
  avg_rsi         REAL,     -- 族群平均 RSI
  avg_momentum_5d REAL,     -- 族群平均5日動能
  stock_count     INTEGER,  -- 族群股票數
  up_count        INTEGER,  -- 上漲家數
  llm_summary     TEXT,     -- LLM 生成的族群分析
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  classification TEXT DEFAULT 'industry',
  UNIQUE(date, sector, classification)
);
CREATE INDEX IF NOT EXISTS idx_sector_flow_date ON sector_flow(date DESC, total_net DESC);

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 注意：增量 Schema 變更請使用獨立 migration 檔案執行，不要放在這裡
-- 首次部署：wrangler d1 execute stockvision-db --remote --file=./worker/schema.sql
-- v12 升級：wrangler d1 execute stockvision-db --remote --file=./worker/migration_v12.sql
-- ─────────────────────────────────────────────────────────────────────────────
