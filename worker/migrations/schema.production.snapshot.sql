PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (
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
CREATE TABLE stocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  market     TEXT NOT NULL DEFAULT 'TWSE' CHECK(market IN ('TWSE','OTC','US')),
  sector     TEXT,
  in_current_watchlist  INTEGER NOT NULL DEFAULT 1,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, source TEXT DEFAULT 'manual', pinned INTEGER NOT NULL DEFAULT 0, listed_date TEXT, delisted_date TEXT, delist_reason TEXT);
CREATE TABLE stock_prices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id   INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  close      REAL,
  adj_close  REAL,
  volume     INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), avg_price REAL,
  UNIQUE(stock_id, date)
);
CREATE TABLE technical_indicators (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  ma5          REAL, ma10 REAL, ma20 REAL, ma60 REAL,
  rsi14        REAL,
  macd         REAL, macd_signal REAL, macd_hist REAL,
  atr14        REAL,
  bb_upper     REAL, bb_mid REAL, bb_lower REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')), plus_di14 REAL, minus_di14 REAL, adx14 REAL, parabolic_sar REAL, cci20 REAL, volume_weighted_rsi14 REAL, volume_momentum_divergence_13_27_10 REAL, squeeze_on REAL, squeeze_release REAL, squeeze_momentum REAL, obv_temperature_60 REAL, adaptive_rsi_midline_50 REAL, adaptive_rsi_upper_50 REAL, adaptive_rsi_lower_50 REAL, adaptive_rsi_overbought REAL, adaptive_rsi_oversold REAL,
  UNIQUE(stock_id, date)
);
CREATE TABLE financials (
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
  created_at         TEXT NOT NULL DEFAULT (datetime('now')), operating_income REAL, net_income REAL, total_assets REAL, total_liabilities REAL,
  UNIQUE(stock_id, period)
);
CREATE TABLE news (
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
CREATE TABLE predictions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id           INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  model_name         TEXT NOT NULL,
  generated_at       TEXT NOT NULL DEFAULT (datetime('now')),
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
, signal_raw TEXT, prediction_date TEXT, verification_label_schema_version TEXT, verification_label_entry_price REAL, verification_label_end_date TEXT, verification_label_known_date TEXT);
CREATE TABLE model_accuracy (
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
CREATE TABLE stock_memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id   INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL,  -- 'pattern' | 'signal_result' | 'key_level'
  content    TEXT NOT NULL,   -- 記憶內容
  confidence REAL DEFAULT 0.5, -- 0~1，基於樣本數
  sample_count INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE watchlist (
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
CREATE TABLE factor_scores (
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
CREATE TABLE risk_metrics (
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
CREATE TABLE alert_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_id         INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  rule_type        TEXT NOT NULL,
  threshold        REAL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  last_triggered   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE market_risk (
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
, adl_value REAL, adl_trend TEXT, margin_maintenance_rate REAL, bull_alignment_count INTEGER, bull_alignment_pct REAL);
CREATE TABLE trade_performance (
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
CREATE TABLE system_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  level       TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
  cron_name   TEXT NOT NULL,
  message     TEXT NOT NULL,
  meta        TEXT,                          -- JSON 附加資訊
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE chat_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  stock_id    INTEGER REFERENCES stocks(id) ON DELETE CASCADE,
  title       TEXT,                         -- 自動摘要（第一則問題前 30 字）
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE alert_notifications (
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
CREATE TABLE daily_recommendations (
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
  created_at   TEXT NOT NULL DEFAULT (datetime('now')), chip_score REAL DEFAULT 0, tech_score REAL DEFAULT 0, ml_score REAL DEFAULT 0, industry TEXT, market_segment TEXT, recommendation_lane TEXT DEFAULT 'tradable', eligible_for_ml INTEGER DEFAULT 1, eligible_for_pending_buy INTEGER DEFAULT 1, alpha_context TEXT, alpha_allocation TEXT, ml_vote_summary TEXT, score_components TEXT, momentum_score REAL DEFAULT 0,
  UNIQUE(date, stock_id)
);
CREATE TABLE paper_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL DEFAULT 'AI 模擬帳戶',
  cash          REAL NOT NULL DEFAULT 1000000.0,   -- 可用現金（台幣）
  initial_cash  REAL NOT NULL DEFAULT 1000000.0,   -- 初始資金（用於計算總報酬）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE paper_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES paper_accounts(id),
  symbol        TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  side          TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  shares        INTEGER NOT NULL,            -- 股數
  price         REAL NOT NULL,               -- 成交價（每股）
  commission    REAL NOT NULL DEFAULT 0,     -- 手續費（買賣雙方各付）
  tax           REAL NOT NULL DEFAULT 0,     -- 交易稅（賣出 0.3%）
  total_cost    REAL NOT NULL,               -- 實際現金異動（buy: 支出正值, sell: 收入負值）
  source        TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'auto_ml'
  signal        TEXT,                        -- 觸發的 ML 訊號（BUY / STRONG_BUY 等）
  confidence    REAL,                        -- ML 信心度
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE paper_positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES paper_accounts(id),
  symbol        TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  shares        INTEGER NOT NULL,            -- 目前持股股數
  avg_cost      REAL NOT NULL,               -- 平均成本（含手續費攤入）
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')), entry_price REAL, entry_date TEXT, initial_stop REAL, trailing_stop REAL, highest_since_entry REAL, stop_multiplier REAL DEFAULT 2.0, tp1_price REAL, tp2_price REAL, tp1_hit INTEGER DEFAULT 0, original_shares INTEGER, trade_lifecycle_json TEXT,
  UNIQUE(account_id, symbol)
);
CREATE TABLE paper_daily_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES paper_accounts(id),
  date            TEXT NOT NULL,
  cash            REAL NOT NULL,
  positions_value REAL NOT NULL,             -- 持倉市值（用收盤價估算）
  total_value     REAL NOT NULL,             -- 總資產 = cash + positions_value
  pnl             REAL NOT NULL,             -- 累計損益（total_value - initial_cash）
  pnl_pct         REAL NOT NULL,             -- 累計報酬率 %
  created_at      TEXT NOT NULL DEFAULT (datetime('now')), benchmark_value     REAL, max_drawdown_to_date REAL, sharpe_30d          REAL, twii_value REAL, sortino_30d REAL, calmar       REAL, cagr         REAL,
  UNIQUE(account_id, date)
);
CREATE TABLE sector_heat (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL,
  sector            TEXT NOT NULL,
  score             REAL NOT NULL,
  chip_flow         REAL,
  relative_strength REAL,
  volume_expansion  REAL,
  momentum          REAL,
  top_stocks        TEXT,           -- JSON array of top symbols
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, sector)
);
CREATE TABLE stock_tags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol    TEXT NOT NULL,
  tag       TEXT NOT NULL,          -- 概念名稱：'記憶體', 'CPO', '矽光子', 'AI Server'...
  source    TEXT DEFAULT 'goodinfo', -- 資料來源：goodinfo / manual / ptt
  weight    REAL DEFAULT 1.0,       -- 關聯強度 0~1（核心成員=1, 邊緣=0.5）
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), tag_type TEXT DEFAULT 'concept',
  UNIQUE(symbol, tag)
);
CREATE TABLE concept_buzz (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  concept    TEXT NOT NULL,          -- 概念名稱（與 stock_tags.tag 對應）
  mention_count INTEGER DEFAULT 0,  -- 被提及次數
  sentiment_avg REAL DEFAULT 0,     -- 平均情緒（推-噓 比例 -1~+1）
  top_posts  TEXT,                   -- JSON: 代表性文章標題 top 3
  source     TEXT DEFAULT 'ptt',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, concept, source)
);
CREATE TABLE monthly_revenue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id    INTEGER NOT NULL REFERENCES stocks(id),
  date        TEXT NOT NULL,           -- "2026-02" 格式（年-月）
  revenue     REAL NOT NULL,           -- 當月營收（千元）
  revenue_yoy REAL,                    -- 年增率 %
  revenue_mom REAL,                    -- 月增率 %
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);
CREATE TABLE market_breadth (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT NOT NULL UNIQUE,
  advance_count         INTEGER,       -- 上漲家數
  decline_count         INTEGER,       -- 下跌家數
  unchanged_count       INTEGER,       -- 平盤家數
  advance_ratio         REAL,          -- 上漲比例 (0-1)
  bull_alignment_pct    REAL,          -- 多頭排列比例 % (MA5>MA20>MA60)
  new_high_count        INTEGER,       -- 創 20 日新高家數
  new_low_count         INTEGER,       -- 創 20 日新低家數
  margin_balance        REAL,          -- 融資餘額（億）
  short_balance         REAL,          -- 融券餘額（張）
  margin_maintenance    REAL,          -- 整體融資維持率 %
  created_at            TEXT DEFAULT (datetime('now'))
, sample_size INTEGER, limit_down_count INTEGER);
CREATE TABLE us_market_signals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL UNIQUE,
  sox_close         REAL,              -- 費半指數收盤
  sox_return        REAL,              -- 費半日漲跌 %
  sox_ma5           REAL,              -- 費半 5 日均線
  tsm_close         REAL,              -- TSMC ADR 收盤
  tsm_return        REAL,              -- TSMC ADR 日漲跌 %
  tsm_premium       REAL,              -- ADR vs 台股溢價 %
  gspc_close        REAL,              -- S&P 500 收盤
  gspc_return       REAL,              -- S&P 500 日漲跌 %
  dxy_close         REAL,              -- 美元指數
  dxy_return        REAL,              -- 美元指數日變化 %
  hy_spread         REAL,              -- HY OAS 信用利差 (bps)
  hy_spread_chg     REAL,              -- 信用利差日變化 (bps)
  vix_close         REAL,              -- VIX 收盤
  sentiment         TEXT,              -- 'bullish' / 'neutral' / 'bearish'
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE TABLE margin_data (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id              INTEGER NOT NULL REFERENCES stocks(id),
  date                  TEXT NOT NULL,
  margin_buy            INTEGER,       -- 融資買入（張）
  margin_sell           INTEGER,       -- 融資賣出（張）
  margin_balance        INTEGER,       -- 融資餘額（張）
  short_buy             INTEGER,       -- 融券買入（張）
  short_sell            INTEGER,       -- 融券賣出（張）
  short_balance         INTEGER,       -- 融券餘額（張）
  margin_usage_pct      REAL,          -- 融資使用率 %（需外部計算或 FinMind 提供）
  short_ratio           REAL,          -- 券資比 = short_balance / margin_balance
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);
CREATE TABLE shareholding (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id              INTEGER NOT NULL REFERENCES stocks(id),
  date                  TEXT NOT NULL,
  total_shares          INTEGER,       -- 總股數
  holder_count          INTEGER,       -- 總股東人數
  retail_shares         INTEGER,       -- 散戶持股（<50張）
  retail_pct            REAL,          -- 散戶持股占比 %
  large_holder_shares   INTEGER,       -- 大戶持股（>=400張）
  large_holder_pct      REAL,          -- 大戶持股占比 %
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);
CREATE TABLE stock_profiles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL UNIQUE,
  name              TEXT,
  sector            TEXT,
  business_desc     TEXT,        -- 業務簡介（max 500 char）
  supply_chain      TEXT,        -- JSON: {upstream: [], midstream: [], downstream: []}
  key_customers     TEXT,        -- JSON array
  key_suppliers     TEXT,        -- JSON array
  financials_summary TEXT,       -- JSON: {annual: [...], quarterly: [...]}
  wikilinks         TEXT,        -- JSON array of [[linked]] entities
  updated_at        TEXT DEFAULT (datetime('now'))
);
CREATE TABLE backtest_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date        TEXT NOT NULL,                    -- 執行日期
  strategy        TEXT NOT NULL,                    -- 策略名稱
  timerange       TEXT,                             -- 回測區間 (e.g. '20240101-20260326')
  total_trades    INTEGER,
  win_rate        REAL,                             -- 0~1
  sharpe          REAL,
  sortino         REAL,
  calmar          REAL,
  max_drawdown    REAL,                             -- 正值 (e.g. 0.12 = 12%)
  cagr            REAL,
  profit_factor   REAL,
  expectancy      REAL,
  raw_results     TEXT,                             -- Full JSON (truncated 50KB)
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, strategy, timerange)
);
CREATE TABLE sector_flow_stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  theme TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  net_amount REAL NOT NULL,        -- 法人淨買賣超（億元）
  foreign_net REAL DEFAULT 0,      -- 外資淨買賣超（億元）
  trust_net REAL DEFAULT 0,        -- 投信淨買賣超（億元）
  volume_ratio REAL,               -- 近5日均量 / 前20日均量（黑馬用）
  classification TEXT NOT NULL DEFAULT 'top', -- 'top' | 'dark_horse'
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS "chip_data" (
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
CREATE TABLE stock_analysis_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, report_type TEXT NOT NULL DEFAULT 'daily', market_summary TEXT, ml_overview TEXT, buy_details TEXT, sell_alerts TEXT, recommendations TEXT, performance TEXT, theme_flow TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(date, report_type));
CREATE TABLE decision_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  action          TEXT NOT NULL,              -- 'BUY' | 'SELL' | 'SWAP_OUT' | 'SKIP'
  -- Factor contributions (from scorer)
  chip_score      REAL,                       -- 0-40
  tech_score      REAL,                       -- 0-30
  ml_score        REAL,                       -- 0-30
  total_score     REAL,                       -- chip + tech + ml
  chip_pct        REAL,                       -- chip_score / total_score (contribution %)
  tech_pct        REAL,
  ml_pct          REAL,
  -- ML detail
  ml_signal       TEXT,                       -- BUY / STRONG_BUY / HOLD / SELL
  ml_confidence   REAL,
  -- Debate verdict
  debate_verdict  TEXT,                       -- APPROVE / DOWNGRADE / REJECT / null
  debate_summary  TEXT,
  -- Model breakdown (JSON: per-model weight + direction)
  model_breakdown TEXT,                       -- JSON [{name, weight, direction, accuracy}, ...]
  -- Context
  market_risk     TEXT,                       -- green/yellow/orange/red/black
  sector          TEXT,
  entry_price     REAL,
  created_at      TEXT DEFAULT (datetime('now')), score_components TEXT,
  UNIQUE(date, symbol, action)
);
CREATE TABLE model_health_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  accuracy_30d    REAL,
  accuracy_90d    REAL,
  profit_factor   REAL,
  expectancy      REAL,
  lifecycle_status TEXT,                      -- 'active' | 'degraded' | 'shadow'
  lifecycle_weight REAL,                      -- current weight multiplier
  ic_mean         REAL,                       -- latest feature IC (if available)
  drift_detected  INTEGER DEFAULT 0,          -- 1 if drift detected
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(date, model_name)
);
CREATE TABLE model_lifecycle_state (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  state_json    TEXT NOT NULL,           -- JSON: per-model {status, weight_mult, accuracy, ...}
  events_json   TEXT,                    -- JSON: events from latest check
  updated_at    TEXT NOT NULL
);
CREATE TABLE model_lifecycle_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date    TEXT NOT NULL,
  model_name    TEXT NOT NULL,
  event_type    TEXT NOT NULL,           -- 'status_change' | 'balance_guard'
  from_status   TEXT,                    -- 'active' | 'degraded' | 'shadow'
  to_status     TEXT,
  accuracy_30d  REAL,
  detail        TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE TABLE monte_carlo_results (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date          TEXT NOT NULL,                    -- 執行日期
  source            TEXT NOT NULL DEFAULT 'paper',    -- 'paper' | 'backtest'
  n_simulations     INTEGER NOT NULL DEFAULT 1000,
  n_trades          INTEGER NOT NULL,                 -- 輸入交易筆數
  historical_mdd    REAL,                             -- 實際歷史 MDD (0~1)
  mdd_median        REAL,                             -- 模擬中位數
  mdd_mean          REAL,                             -- 模擬平均
  mdd_std           REAL,                             -- MDD 標準差
  mdd_95th          REAL,                             -- 95% 信賴區間上限 ← 主指標
  mdd_99th          REAL,                             -- 99% 信賴區間上限
  mdd_worst         REAL,                             -- 最差情境
  mdd_best          REAL,                             -- 最佳情境
  go_live_verdict   TEXT,                             -- 'PASS' | 'CAUTION' | 'FAIL'
  verdict_reason    TEXT,                             -- 判決說明
  raw_distribution  TEXT,                             -- Full JSON (distribution + histogram)
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, source)
);
CREATE TABLE pbo_results (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date          TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'backtest',  -- 'backtest' | 'paper'
  n_partitions      INTEGER NOT NULL DEFAULT 10,
  n_combinations    INTEGER NOT NULL,                  -- C(S, S/2) 總組合數
  n_trades          INTEGER NOT NULL,
  pbo               REAL NOT NULL,                     -- 0~1, 核心指標
  n_oos_negative    INTEGER NOT NULL,                  -- OOS 賠錢的組合數
  oos_mean_return   REAL,                              -- OOS 平均報酬
  is_mean_return    REAL,                              -- IS 平均報酬
  degradation       REAL,                              -- IS - OOS (過擬合差距)
  go_live_verdict   TEXT,                              -- 'PASS' | 'FAIL'
  verdict_reason    TEXT,
  raw_details       TEXT,                              -- Full JSON
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, source)
);
CREATE TABLE weekly_audit_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date   TEXT NOT NULL UNIQUE,
  report_text   TEXT NOT NULL,              -- Human-readable markdown report
  l1_json       TEXT,                       -- L1 trade performance data
  l2_json       TEXT,                       -- L2 decision attribution data
  l3_json       TEXT,                       -- L3 model health data
  risk_json     TEXT,                       -- MC + PBO risk assessment
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS "sector_flow" (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  sector          TEXT NOT NULL,
  foreign_net     REAL,
  trust_net       REAL,
  total_net       REAL,
  avg_rsi         REAL,
  avg_momentum_5d REAL,
  stock_count     INTEGER,
  up_count        INTEGER,
  llm_summary     TEXT,
  classification  TEXT DEFAULT 'industry',
  rs_ratio        REAL,
  rs_momentum     REAL,
  quadrant        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')), turnover_value REAL, turnover_share REAL, turnover_share_delta REAL, rotation_velocity REAL, rotation_acceleration REAL, quadrant_age INTEGER, transition_path TEXT, rotation_score REAL, rotation_regime TEXT, rotation_hysteresis TEXT, rotation_window INTEGER, rrg_tail_json TEXT, updated_at TEXT, pit_lineage_version TEXT,
  UNIQUE(date, sector, classification)
);
CREATE TABLE paper_settlements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL,
  order_id        INTEGER NOT NULL,
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK(side IN ('buy','sell')),
  amount          REAL NOT NULL,
  trade_date      TEXT NOT NULL,
  settlement_date TEXT NOT NULL,
  settled         INTEGER NOT NULL DEFAULT 0,
  settled_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE screener_momentum_snapshots (
  date                  TEXT PRIMARY KEY,         -- trading day (TW timezone YYYY-MM-DD)
  candidate_count       INTEGER NOT NULL,         -- size of screener candidate pool
  avg_5d_return         REAL,                     -- mean 5-day return of candidates
  pct_oversold          REAL,                     -- % of candidates with RSI < 30 OR close < MA20
  pct_overbought        REAL,                     -- % of candidates with RSI > 70
  avg_dist_from_high    REAL,                     -- mean distance below 52-week high (fraction, e.g. 0.12 = 12% below)
  breadth_score         REAL,                     -- advance/decline-weighted score, [-1, 1]
  -- Zone fields (computed at write time against prior 36 months)
  percentile_rank       REAL,                     -- rank of today's pct_oversold in [0, 1]; lower = more crowded/risky
  zone                  TEXT NOT NULL DEFAULT 'GREEN', -- 'RED' | 'YELLOW' | 'GREEN'
  created_at            TEXT DEFAULT (datetime('now'))
);
CREATE TABLE persona_opinions (
  date                   TEXT NOT NULL,      -- trading day (TW timezone YYYY-MM-DD)
  symbol                 TEXT NOT NULL,

  -- ── 投信 agent (institutional trust) ─────────────────────────────────────
  trust_signal           TEXT,               -- 'BUY' | 'SELL' | 'NEUTRAL'
  trust_strength         REAL,               -- 0..1 confidence
  trust_reason           TEXT,               -- human-readable explanation
  trust_is_window_dress  INTEGER DEFAULT 0,  -- 1 = quarter-end window-dressing zone (strength downweighted)

  -- ── 散戶 agent (retail, contrarian) ──────────────────────────────────────
  retail_signal          TEXT,               -- 'BUY' | 'SELL' | 'NEUTRAL' | 'CAUTION'
  retail_strength        REAL,
  retail_reason          TEXT,

  -- ── Meta ─────────────────────────────────────────────────────────────────
  created_at             TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (date, symbol)
);
CREATE TABLE webhook_log (
  idempotency_key TEXT PRIMARY KEY,
  received_at     TEXT NOT NULL,        -- ISO8601 UTC
  source          TEXT NOT NULL,        -- 'ml-service' | 'optuna' | etc
  action          TEXT NOT NULL,        -- 'retrain_followup' | 'optuna_complete' | ...
  payload_summary TEXT,                 -- JSON string of key fields (avoid full payload bloat)
  status          TEXT NOT NULL,        -- 'logged' | 'triggered' | 'skipped_dup' | 'error'
  downstream_notes TEXT                 -- what action was actually taken
);
CREATE TABLE debate_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  debate_date TEXT NOT NULL,       -- YYYY-MM-DD (TW local)
  thesis_summary TEXT NOT NULL,    -- ≤200 字 debate 結論
  direction TEXT NOT NULL,         -- 'bullish' | 'bearish' | 'neutral'
  key_factors TEXT,                -- JSON array string, e.g. '["外資連買","MA20突破"]'
  verdict TEXT,                    -- 'APPROVE' | 'DOWNGRADE' | 'REJECT'
  conviction_score INTEGER,        -- 0-100 judge 信念度
  llm_source TEXT,                 -- 'tunnel' | 'gemini_api' | 'anthropic_api'
  created_at TEXT NOT NULL         -- ISO8601 UTC
);
CREATE TABLE config_lifecycle_state (
  id                        INTEGER PRIMARY KEY DEFAULT 1,
  state_json                TEXT NOT NULL,           -- JSON: {champion_hash, challenger_hash, champion_perf, challenger_perf, consecutive_wins, consecutive_losses, shadow_since, ...}
  last_eval_json            TEXT,                    -- JSON: latest eval result from replay_period
  updated_at                TEXT NOT NULL
);
CREATE TABLE config_lifecycle_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date        TEXT NOT NULL,
  event_type        TEXT NOT NULL,           -- 'challenger_set' | 'eval_done' | 'promote' | 'retire' | 'alert'
  challenger_source TEXT,                    -- 'sandbox' | 'manual' | 'auto' (where challenger came from)
  champion_hash     TEXT,
  challenger_hash   TEXT,
  sharpe_delta      REAL,                    -- challenger_sharpe - champion_sharpe
  win_rate_delta    REAL,
  max_dd_delta      REAL,
  detail            TEXT,                    -- freeform JSON blob with full metrics
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE TABLE exit_shadow_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  TEXT NOT NULL,            -- ISO timestamp (UTC)
  date                TEXT NOT NULL,            -- TW date YYYY-MM-DD (derived at insert)
  caller              TEXT NOT NULL,            -- 'runEODExit' | 'forceDayTradeClose' | 'pollIntradayStopLoss'
  symbol              TEXT NOT NULL,
  regime              TEXT NOT NULL,            -- 'bull' | 'bear' | 'volatile' | 'sideways'
  actual_action       TEXT NOT NULL,            -- 'full_sell' | 'half_sell' | 'hold' | ...
  actual_reason       TEXT,                     -- free-form reason string from ExitDecision
  hypothetical_order  TEXT,                     -- JSON array of layer names in regime-suggested order
  hypothetical_mult   TEXT                      -- JSON: {hardStop, atrTrail, tp1, tp2, timeStop}
);
CREATE TABLE screener_selection_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,              -- TW YYYY-MM-DD
  stock_id   INTEGER,                    -- FK stocks.id (nullable: 若 stock 未建立不強制)
  symbol     TEXT NOT NULL,              -- 同時記 symbol 方便 query 不需 join
  score      REAL,                       -- combined screener score (chip+tech+momentum)
  industry   TEXT,
  UNIQUE(date, symbol)                   -- 防止同日重複 insert
);
CREATE TABLE sector_leaders (
  sector            TEXT NOT NULL,
  rank              INTEGER NOT NULL,        -- 1, 2, 3 (top 3)
  stock_id          INTEGER,
  symbol            TEXT NOT NULL,
  avg_turnover_60d  REAL,                    -- avg(close*volume) over last 60 trading days
  computed_at       TEXT NOT NULL,
  PRIMARY KEY (sector, rank)
);
CREATE TABLE risk_audit_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp             TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_event         TEXT NOT NULL,        -- 'morning_setup' | 'intraday_buy' | 'intraday_exit' | 'eod_exit' | 'kill_switch' | 'force_day_trade_close'
  account_id            INTEGER NOT NULL DEFAULT 1,
  symbol                TEXT,                 -- null for portfolio-only events
  side                  TEXT,                 -- 'buy' | 'sell' | null
  decision              TEXT NOT NULL,        -- 'executed' | 'blocked' | 'adjusted' | 'deferred' | 'halt'
  halt                  INTEGER NOT NULL DEFAULT 0,
  triggered_count       INTEGER NOT NULL DEFAULT 0,
  severity              TEXT NOT NULL DEFAULT 'normal',  -- 'normal' | 'elevated' | 'high' | 'critical' | 'halted'
  max_position_pct      REAL,
  buy_conf_threshold    REAL,
  sell_conf_threshold   REAL,
  risk_state_json       TEXT NOT NULL,        -- full AggregatedRiskState (includes triggered layer list + reasons)
  order_validation_json TEXT,                 -- OrderValidation when trigger is order-related
  config_version        TEXT,                 -- trading:risk_config hash or timestamp
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE cost_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,              -- ISO UTC timestamp
  date            TEXT NOT NULL,              -- TW YYYY-MM-DD (derived)
  source          TEXT NOT NULL,              -- 'llm_reason' | 'llm_debate' | 'llm_newsanalyst' | 'modal_function' | 'manual'
  provider        TEXT,                       -- 'anthropic' | 'gemini' | 'deepseek' | 'modal' | ...
  model           TEXT,                       -- e.g. 'claude-sonnet-4-6', 'gemini-3.1-flash-lite', 'run_mine_cycle'
  tokens_in       INTEGER,                    -- null for non-LLM
  tokens_out      INTEGER,
  compute_sec     REAL,                       -- Modal function runtime (null for LLM)
  est_usd         REAL NOT NULL,              -- estimated cost in USD
  meta            TEXT                        -- freeform JSON blob (call_id / cycle / stock / ...)
);
CREATE TABLE debate_ab_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  date              TEXT NOT NULL,              -- TW YYYY-MM-DD
  symbol            TEXT NOT NULL,
  model_assigned    TEXT NOT NULL,              -- 'gemini' | 'anthropic'
  model_actual      TEXT,                       -- what actually served (fallback awareness)
  verdict           TEXT,                       -- 'BUY' | 'HOLD' | 'DOWNGRADE' | etc.
  conviction_score  REAL,
  summary_len       INTEGER,
  debate_rounds     INTEGER,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  meta              TEXT                        -- JSON blob for context
);
CREATE TABLE pending_buy_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date        TEXT NOT NULL,
  source_reco_date  TEXT,
  status            TEXT NOT NULL DEFAULT 'ready',       -- ready | empty | halted | error | superseded
  debate_status     TEXT NOT NULL DEFAULT 'pending',     -- pending | completed | failed | skipped
  candidate_count   INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE pending_buy_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES pending_buy_runs(id) ON DELETE CASCADE,
  symbol            TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  signal            TEXT NOT NULL DEFAULT 'BUY',
  confidence        REAL NOT NULL DEFAULT 0,
  ml_entry_price    REAL NOT NULL DEFAULT 0,
  ml_stop_loss      REAL,
  ml_target1        REAL,
  ml_target2        REAL,
  reason            TEXT,
  watch_points_json TEXT,
  debate_verdict    TEXT NOT NULL DEFAULT 'PENDING',
  debate_status     TEXT NOT NULL DEFAULT 'pending',
  execution_status  TEXT NOT NULL DEFAULT 'pending',
  risk_pct          REAL NOT NULL DEFAULT 0,
  kelly_pct         REAL,
  chip_score        REAL,
  tech_score        REAL,
  ml_score          REAL,
  score             REAL,
  source            TEXT,
  original_entry    REAL,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')), debate_turns_json TEXT,
  UNIQUE(run_id, symbol)
);
CREATE TABLE paper_order_intents (
  intent_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  order_id INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE paper_execution_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL DEFAULT 1,
  trade_date      TEXT NOT NULL,
  symbol          TEXT,
  side            TEXT,
  event_type      TEXT NOT NULL, -- pending_buy | paper_order | debate | snapshot_audit
  status          TEXT NOT NULL,
  reason          TEXT,
  detail_json     TEXT,
  order_id        INTEGER,
  pending_run_id  INTEGER,
  source          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE observability_events (
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
CREATE TABLE stock_trading_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  restriction_type TEXT NOT NULL DEFAULT 'punished',
  source TEXT NOT NULL DEFAULT 'twse',
  reason TEXT,
  start_date TEXT,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE screener_funnel_runs (
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
CREATE TABLE screener_funnel_items (
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
CREATE TABLE dataset_snapshots (
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
CREATE TABLE meta_reward_ledger (
  policy_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  context_hash TEXT NOT NULL DEFAULT 'global',
  samples INTEGER NOT NULL DEFAULT 0,
  reward_sum REAL NOT NULL DEFAULT 0,
  reward_mean REAL,
  last_reward_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evidence_json TEXT,
  PRIMARY KEY (policy_id, arm_id, context_hash)
);
CREATE TABLE meta_shadow_decisions (
  decision_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  symbol TEXT,
  arm_id TEXT,
  baseline_action TEXT,
  shadow_action TEXT,
  counterfactual_reward REAL,
  context_json TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE model_champion_pointers (
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
CREATE TABLE scheduler_locks (
  lock_key   TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  run_date   TEXT,
  run_id     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);
CREATE TABLE compute_profile_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  job_name        TEXT NOT NULL,
  run_id          TEXT,
  wall_sec        REAL,
  compute_sec     REAL,
  cpu             REAL,
  memory_mb       INTEGER,
  gpu             TEXT,
  est_usd         REAL,
  rows            INTEGER,
  features        INTEGER,
  symbols         INTEGER,
  trials          INTEGER,
  cache_hit_ratio REAL,
  profile_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
, await_sec REAL, compute_owner TEXT, remote_function TEXT);
CREATE TABLE compute_efficiency_reports (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date             TEXT NOT NULL,
  job_name                TEXT NOT NULL,
  decision                TEXT NOT NULL,
  baseline_profile_json   TEXT,
  optimized_profile_json  TEXT,
  quality_json            TEXT,
  efficiency_json         TEXT,
  report_json             TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE paper_challenger_candidates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id           TEXT NOT NULL UNIQUE,
  candidate_type         TEXT NOT NULL,
  current_state          TEXT NOT NULL, -- candidate | clean_asset | paper_active_challenger | paper_primary | real_review_ready
  source                 TEXT NOT NULL,
  feature_set_version    TEXT,
  first_seen_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  promotion_packet_json  TEXT,
  notes                  TEXT
);
CREATE TABLE paper_decision_attribution (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date            TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  decision              TEXT NOT NULL,
  paper_lane            TEXT NOT NULL,
  candidate_source      TEXT NOT NULL,
  baseline_score        REAL,
  challenger_score      REAL,
  decision_delta        REAL,
  feature_set_version   TEXT,
  regime_version        TEXT,
  evidence_sources_json TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE paper_challenger_daily_metrics (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date           TEXT NOT NULL,
  candidate_id         TEXT NOT NULL,
  paper_decision_count INTEGER NOT NULL DEFAULT 0,
  precision_at_k       REAL,
  hit_rate             REAL,
  avg_return_pct       REAL,
  max_drawdown_pct     REAL,
  turnover_ratio       REAL,
  topk_overlap         REAL,
  regime_split_passed  INTEGER NOT NULL DEFAULT 0,
  runtime_speedup_pct  REAL,
  metrics_json         TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trade_date, candidate_id)
);
CREATE TABLE promotion_audit_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id         TEXT NOT NULL,
  from_state           TEXT,
  to_state             TEXT,
  decision             TEXT NOT NULL,
  failed_gates_json    TEXT,
  packet_json          TEXT NOT NULL,
  real_trading_effect  TEXT NOT NULL DEFAULT 'none',
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE finlab_backfill_runs (
  run_id          TEXT PRIMARY KEY,
  generated_at    TEXT NOT NULL,
  lookback_years  INTEGER NOT NULL DEFAULT 5,
  dataset_count   INTEGER NOT NULL DEFAULT 0,
  finlab_rows     INTEGER NOT NULL DEFAULT 0,
  gap_fill_rows   INTEGER NOT NULL DEFAULT 0,
  value_conflicts INTEGER NOT NULL DEFAULT 0,
  checksum        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ready',
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE source_diff_report (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT NOT NULL,
  dataset_lane           TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'finlab',
  generated_at           TEXT NOT NULL,
  finlab_rows            INTEGER NOT NULL DEFAULT 0,
  stockvision_rows       INTEGER NOT NULL DEFAULT 0,
  matched_rows           INTEGER NOT NULL DEFAULT 0,
  missing_in_stockvision INTEGER NOT NULL DEFAULT 0,
  missing_in_finlab      INTEGER NOT NULL DEFAULT 0,
  value_conflicts        INTEGER NOT NULL DEFAULT 0,
  schema_extra_fields    TEXT,
  report_json            TEXT NOT NULL,
  checksum               TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE gap_fill_candidates (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT NOT NULL,
  dataset_lane           TEXT NOT NULL,
  canonical_table        TEXT NOT NULL,
  stock_id               TEXT,
  symbol                 TEXT,
  date                   TEXT,
  market_segment         TEXT,
  field                  TEXT,
  finlab_value           TEXT,
  stockvision_value      TEXT,
  source                 TEXT NOT NULL DEFAULT 'finlab',
  lineage_json           TEXT NOT NULL,
  decision               TEXT NOT NULL DEFAULT 'candidate',
  generated_at           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE data_source_inventory (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  source                 TEXT NOT NULL,
  dataset                TEXT NOT NULL,
  field                  TEXT NOT NULL,
  stock_id               TEXT,
  market_segment         TEXT,
  date                   TEXT,
  as_of_date             TEXT NOT NULL,
  coverage_status        TEXT NOT NULL,
  freshness_status       TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, dataset, field, stock_id, market_segment, as_of_date)
);
CREATE TABLE canonical_market_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT,
  open                   REAL,
  high                   REAL,
  low                    REAL,
  close                  REAL,
  volume                 REAL,
  value                  REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, adj_open REAL, adj_high REAL, adj_low REAL, adj_close REAL, market_value REAL, trade_count REAL, avg_price REAL, last_bid_price REAL, last_ask_price REAL, last_bid_volume REAL, last_ask_volume REAL,
  PRIMARY KEY(stock_id, date, source)
);
CREATE TABLE canonical_chip_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT,
  foreign_net            REAL,
  trust_net              REAL,
  dealer_net             REAL,
  margin_balance         REAL,
  short_balance          REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, broker_top15_buy REAL, broker_top15_sell REAL, broker_buy_sell_ratio REAL, broker_balance_index REAL, margin_buy REAL, margin_sell REAL, margin_cash_repayment REAL, margin_prev_balance REAL, margin_limit REAL, short_buy REAL, short_sell REAL, short_stock_repayment REAL, short_prev_balance REAL, short_limit REAL, margin_short_offset REAL, margin_usage_ratio REAL, short_usage_ratio REAL, foreign_buy REAL, foreign_sell REAL, foreign_dealer_buy REAL, foreign_dealer_sell REAL, foreign_dealer_net REAL, trust_buy REAL, trust_sell REAL, dealer_buy REAL, dealer_sell REAL, dealer_self_buy REAL, dealer_self_sell REAL, dealer_hedge_buy REAL, dealer_hedge_sell REAL, margin_balance_total_buy REAL, margin_balance_total_sell REAL, margin_balance_total_repayment REAL, margin_balance_total_balance REAL, security_lending_prev_balance REAL, security_lending_borrow REAL, security_lending_return REAL, security_lending_delta REAL, security_lending_balance REAL, security_lending_sell REAL, security_lending_sell_return REAL, security_lending_sell_balance REAL, security_lending_sell_limit REAL,
  PRIMARY KEY(stock_id, date, source)
);
CREATE TABLE canonical_revenue_monthly (
  stock_id               TEXT NOT NULL,
  revenue_month          TEXT NOT NULL,
  market_segment         TEXT,
  revenue                REAL,
  mom                    REAL,
  yoy                    REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, previous_month_revenue REAL, last_year_month_revenue REAL, cumulative_revenue REAL, last_year_cumulative_revenue REAL, previous_comparison_pct REAL,
  PRIMARY KEY(stock_id, revenue_month, source)
);
CREATE TABLE source_quality_metrics (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  source                 TEXT NOT NULL,
  dataset                TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  freshness_status       TEXT NOT NULL,
  missing_rate           REAL NOT NULL DEFAULT 0,
  duplicate_rate         REAL NOT NULL DEFAULT 0,
  schema_drift_status    TEXT NOT NULL DEFAULT 'ok',
  entity_link_confidence REAL,
  latest_materialization TEXT,
  metrics_json           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, dataset, as_of_date)
);
CREATE TABLE external_evidence_items (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id                  TEXT NOT NULL,
  source_kind                TEXT NOT NULL,
  title                      TEXT NOT NULL,
  published_at               TEXT NOT NULL,
  source_url                 TEXT NOT NULL,
  symbols_json               TEXT,
  themes_json                TEXT,
  allowed_use                TEXT NOT NULL,
  decision_effect            TEXT NOT NULL,
  source_quality_score       REAL NOT NULL,
  entity_linking_confidence  REAL NOT NULL,
  spam_filter_status         TEXT NOT NULL DEFAULT 'clean',
  accepted                   INTEGER NOT NULL DEFAULT 1,
  packet_checksum            TEXT,
  raw_json                   TEXT,
  created_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE theme_signals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT NOT NULL,
  concept          TEXT NOT NULL,
  source           TEXT NOT NULL,
  score            REAL NOT NULL,
  sentiment_avg    REAL NOT NULL DEFAULT 0,
  evidence_count   INTEGER NOT NULL DEFAULT 1,
  symbols_json     TEXT,
  top_titles       TEXT,
  allowed_use      TEXT,
  decision_effect  TEXT,
  generated_at     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, concept, source)
);
CREATE TABLE stock_theme_features (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  concept               TEXT NOT NULL,
  score                 REAL NOT NULL,
  evidence_count        INTEGER NOT NULL DEFAULT 1,
  source_breakdown_json TEXT,
  top_titles            TEXT,
  generated_at          TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, symbol, concept)
);
CREATE TABLE canonical_broker_flow_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT NOT NULL DEFAULT 'EMERGING',
  buy_shares             REAL,
  sell_shares            REAL,
  net_shares             REAL,
  dominant_net_shares    REAL,
  gross_imbalance_shares REAL,
  estimated_amount       REAL,
  broker_count           INTEGER,
  concentration          REAL,
  source                 TEXT NOT NULL DEFAULT 'finlab.rotc_broker_transactions',
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, date, source)
);
CREATE TABLE finlab_taxonomy_tags (
  symbol                 TEXT NOT NULL,
  tag                    TEXT NOT NULL,
  tag_type               TEXT NOT NULL,
  source                 TEXT NOT NULL,
  weight                 REAL NOT NULL DEFAULT 1,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, tag, tag_type, source)
);
CREATE TABLE finlab_materialization_manifest (
  run_id                 TEXT PRIMARY KEY,
  generated_at           TEXT NOT NULL,
  source_run_id          TEXT,
  artifact_root          TEXT NOT NULL,
  row_counts_json        TEXT NOT NULL,
  freshness_json         TEXT NOT NULL,
  checksum               TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ready',
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE canonical_trading_restrictions (
  symbol                 TEXT NOT NULL,
  restriction_type       TEXT NOT NULL,
  market_segment         TEXT,
  start_date             TEXT,
  end_date               TEXT,
  source                 TEXT NOT NULL,
  source_date            TEXT NOT NULL,
  title                  TEXT,
  source_url             TEXT,
  lineage_json           TEXT NOT NULL,
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, restriction_type, source, source_date)
);
CREATE TABLE market_regime_factor_packets (
  date                   TEXT PRIMARY KEY,
  schema_version         TEXT NOT NULL,
  score                  INTEGER NOT NULL,
  level                  TEXT NOT NULL,
  factor_json            TEXT NOT NULL,
  contribution_json      TEXT NOT NULL,
  source_json            TEXT NOT NULL,
  freshness_json         TEXT NOT NULL,
  missing_reason_json    TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  generated_at           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE strategy_spec_registry (
  strategy_id              TEXT NOT NULL,
  version                  TEXT NOT NULL,
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('research','shadow','candidate','active','retired')),
  owner                    TEXT NOT NULL DEFAULT 'strategy',
  alpha_bucket             TEXT NOT NULL,
  supported_regimes_json   TEXT NOT NULL DEFAULT '[]',
  thesis                   TEXT NOT NULL,
  thresholds_json          TEXT NOT NULL DEFAULT '{}',
  risk_notes_json          TEXT NOT NULL DEFAULT '[]',
  source_refs_json         TEXT NOT NULL DEFAULT '[]',
  created_by               TEXT NOT NULL DEFAULT 'p5_strategy_governance',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, family_id TEXT NOT NULL DEFAULT 'TREND_RECLAIM_CONTINUATION', variant_id TEXT NOT NULL DEFAULT '', owner_type TEXT NOT NULL DEFAULT 'strategy', promotion_status TEXT NOT NULL DEFAULT 'production', candidate_policy_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(strategy_id, version)
);
CREATE TABLE strategy_decision_log (
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
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, context_id TEXT, evidence_artifact_id TEXT, evaluable INTEGER NOT NULL DEFAULT 0 CHECK(evaluable IN (0,1)), unavailable_reason TEXT,
  UNIQUE(date, symbol, strategy_id, strategy_version)
);
CREATE TABLE strategy_reward_ledger (
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
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, refresh_run_id TEXT,
  UNIQUE(strategy_id, strategy_version, horizon_days, market_segment, regime)
);
CREATE TABLE strategy_policy_state (
  policy_id                TEXT PRIMARY KEY,
  version                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('shadow','candidate','active','retired')),
  strategy_weights_json    TEXT NOT NULL DEFAULT '{}',
  threshold_deltas_json    TEXT NOT NULL DEFAULT '{}',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE canonical_institutional_amount_daily (
  date                   TEXT NOT NULL,
  market_segment         TEXT NOT NULL,
  investor               TEXT NOT NULL,
  category               TEXT,
  buy_amount             REAL,
  sell_amount            REAL,
  net_amount             REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(date, market_segment, investor, source)
);
CREATE TABLE parameter_candidate_registry (
        candidate_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        config_hash TEXT,
        sandbox_id TEXT,
        cadence TEXT,
        run_id TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT,
        latest_evidence_json TEXT,
        promotion_packet_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE parameter_candidate_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        evidence_json TEXT,
        promotion_packet_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE parameter_candidate_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT,
        event_type TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE canonical_fundamental_features (
  stock_id                    TEXT NOT NULL,
  period                      TEXT NOT NULL,
  market_segment              TEXT,
  report_date                 TEXT,
  available_date              TEXT NOT NULL,
  revenue_growth_yoy          REAL,
  gross_margin                REAL,
  operating_margin            REAL,
  roe                         REAL,
  eps                         REAL,
  pe                          REAL,
  pb                          REAL,
  dividend_yield              REAL,
  debt_ratio                  REAL,
  current_ratio               REAL,
  operating_cash_flow         REAL,
  industry_quality_percentile REAL,
  source                      TEXT NOT NULL,
  lineage_json                TEXT NOT NULL,
  as_of_date                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, roa REAL, free_cash_flow REAL, capital_amount REAL, common_stock_capital REAL, preferred_stock_capital REAL, total_assets REAL, total_liabilities REAL, equity_parent REAL, ebitda REAL, financial_cost REAL, operating_expenses REAL, cash_flow_per_share REAL, pretax_income_per_share REAL, property_plant_equipment REAL, working_capital REAL, current_liabilities REAL, operating_cash_flow_statement REAL, non_current_assets REAL, cash_and_cash_equivalents_increase_decrease REAL, other_payables REAL, roa_comprehensive REAL, roe_comprehensive REAL, ebitda_margin REAL, pretax_margin REAL, net_margin REAL, non_operating_income_revenue_ratio REAL, berry_ratio REAL, operating_expense_ratio REAL, sales_expense_ratio REAL, admin_expense_ratio REAL, rd_expense_ratio REAL, cash_flow_ratio REAL, tax_rate REAL, sales_per_share REAL, operating_income_per_share REAL, comprehensive_income_per_share REAL, liabilities_to_equity REAL, equity_to_assets REAL, gross_margin_growth REAL, operating_income_growth REAL, pretax_income_growth REAL, net_income_growth REAL, recurring_income_growth REAL, total_assets_growth REAL, equity_growth REAL, quick_ratio REAL, interest_expense_ratio REAL, total_asset_turnover REAL, receivables_turnover REAL, inventory_turnover REAL, fixed_asset_turnover REAL, equity_turnover REAL, revenue REAL, operating_income REAL, net_income REAL,
  PRIMARY KEY(stock_id, period, source)
);
CREATE TABLE state_space_shadow_results (
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
CREATE TABLE strategy_mining_runs ( run_id TEXT PRIMARY KEY, run_date TEXT, cadence TEXT NOT NULL DEFAULT 'monthly', algorithm TEXT NOT NULL DEFAULT 'pymoo_nsga3_novelty', feature_registry_version TEXT NOT NULL, feature_pool_count INTEGER NOT NULL, core_prior_count INTEGER NOT NULL, evidence_watch_count INTEGER NOT NULL, config_json TEXT NOT NULL, telemetry_json TEXT, status TEXT NOT NULL DEFAULT 'created', decision_effect TEXT NOT NULL DEFAULT 'research_only', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE strategy_mining_candidates ( candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, algorithm TEXT NOT NULL DEFAULT 'pymoo_nsga3_novelty', factor_ids_json TEXT NOT NULL, factor_weights_json TEXT, family_id TEXT, novelty_score REAL, similarity_penalty REAL, max_pairwise_similarity REAL, validation_status TEXT NOT NULL DEFAULT 'research_candidate', promotion_state TEXT NOT NULL DEFAULT 'research_candidate', decision_effect TEXT NOT NULL DEFAULT 'none', metrics_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id) );
CREATE TABLE strategy_backtest_results ( id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, run_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'finlab', start_date TEXT, end_date TEXT, cagr REAL, sharpe REAL, max_drawdown REAL, calmar REAL, turnover REAL, pbo REAL, pbo_verdict TEXT, deflated_sharpe_probability REAL, walk_forward_verdict TEXT, hit_overlap REAL, l1_5_diversity_delta REAL, l2_l3_retention_delta REAL, l4_buy_stability REAL, decision TEXT NOT NULL DEFAULT 'research_only', evidence_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(candidate_id) REFERENCES strategy_mining_candidates(candidate_id), FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id) );
CREATE TABLE strategy_similarity_matrix ( id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, left_id TEXT NOT NULL, right_id TEXT NOT NULL, similarity REAL NOT NULL, similarity_method TEXT NOT NULL DEFAULT 'formal137_pairwise_abs_rank_corr', feature_overlap REAL, hit_overlap REAL, cluster_overlap REAL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(run_id, left_id, right_id), FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id) );
CREATE TABLE strategy_promotion_ledger ( ledger_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, run_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, decision TEXT NOT NULL, failed_gates_json TEXT NOT NULL DEFAULT '[]', packet_json TEXT NOT NULL, real_trading_effect TEXT NOT NULL DEFAULT 'none', approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(candidate_id) REFERENCES strategy_mining_candidates(candidate_id), FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id) );
CREATE TABLE active_strategy_backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  strategy_scope TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'finlab_strategy_spec_backtest',
  start_date TEXT,
  end_date TEXT,
  cagr REAL,
  sharpe REAL,
  max_drawdown REAL,
  calmar REAL,
  turnover REAL,
  signal_status TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE pending_buy_filter_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES pending_buy_runs(id) ON DELETE CASCADE,
  trade_date        TEXT NOT NULL,
  source_reco_date  TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  name              TEXT,
  stage             TEXT NOT NULL,
  action            TEXT NOT NULL,
  reason_code       TEXT NOT NULL,
  theme             TEXT,
  classification    TEXT,
  quadrant          TEXT,
  rs_ratio          REAL,
  rs_momentum       REAL,
  risk_multiplier   REAL,
  details_json      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE canonical_broker_rank_daily (
  stock_id       TEXT NOT NULL,
  date           TEXT NOT NULL,
  market_segment TEXT NOT NULL DEFAULT 'LISTED_OTC',
  rank_side      TEXT NOT NULL CHECK(rank_side IN ('buy', 'sell')),
  rank_no        INTEGER NOT NULL CHECK(rank_no BETWEEN 1 AND 3),
  broker_code    TEXT,
  broker_name    TEXT,
  buy_lots       REAL,
  sell_lots      REAL,
  net_lots       REAL,
  source         TEXT NOT NULL DEFAULT 'finlab.broker_transactions',
  lineage_json   TEXT NOT NULL,
  as_of_date     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, date, source, rank_side, rank_no)
);
CREATE TABLE canonical_market_index_daily (
  symbol                 TEXT NOT NULL,
  date                   TEXT NOT NULL,
  name                   TEXT,
  market_segment         TEXT,
  open                   REAL,
  high                   REAL,
  low                    REAL,
  close                  REAL,
  change                 REAL,
  change_pct             REAL,
  volume                 REAL,
  value                  REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, date, source)
);
CREATE TABLE canonical_futures_daily (
  symbol                 TEXT NOT NULL,
  date                   TEXT NOT NULL,
  contract_month         TEXT NOT NULL,
  session                TEXT NOT NULL DEFAULT 'day',
  open                   REAL,
  high                   REAL,
  low                    REAL,
  close                  REAL,
  change                 REAL,
  change_pct             REAL,
  volume                 REAL,
  open_interest          REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, date, contract_month, session, source)
);
CREATE TABLE canonical_regime_context_daily (
  date                   TEXT NOT NULL,
  dataset                TEXT NOT NULL,
  field                  TEXT NOT NULL,
  category               TEXT NOT NULL DEFAULT 'market',
  value                  REAL,
  text_value             TEXT,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(date, dataset, field, category, source)
);
CREATE TABLE canonical_market_summary_daily (
  date                       TEXT NOT NULL,
  market_segment             TEXT NOT NULL,
  advance_count              REAL,
  unchanged_count            REAL,
  decline_count              REAL,
  total_volume               REAL,
  total_value                REAL,
  margin_buy_units           REAL,
  margin_sell_units          REAL,
  margin_return_units        REAL,
  margin_balance_units       REAL,
  margin_buy_value           REAL,
  margin_sell_value          REAL,
  margin_return_value        REAL,
  margin_balance_value       REAL,
  margin_balance_change_pct  REAL,
  short_buy_units            REAL,
  short_sell_units           REAL,
  short_return_units         REAL,
  short_balance_units        REAL,
  short_balance_change_pct   REAL,
  source                     TEXT NOT NULL,
  lineage_json               TEXT NOT NULL,
  as_of_date                 TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(date, market_segment)
);
CREATE TABLE source_key_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL,
  target_date       TEXT NOT NULL,
  lane              TEXT NOT NULL,
  canonical_dataset TEXT,
  field             TEXT NOT NULL,
  api_key           TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'finlab',
  required          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL,
  rows              INTEGER NOT NULL DEFAULT 0,
  target_rows       INTEGER NOT NULL DEFAULT 0,
  latest_date       TEXT,
  artifact_uri      TEXT,
  artifact_path     TEXT,
  artifact_checksum TEXT,
  error_code        TEXT,
  error_message     TEXT,
  generated_at      TEXT NOT NULL,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE source_key_report (
  target_date       TEXT NOT NULL,
  lane              TEXT NOT NULL,
  field             TEXT NOT NULL,
  api_key           TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'finlab',
  canonical_dataset TEXT,
  required          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL,
  rows              INTEGER NOT NULL DEFAULT 0,
  target_rows       INTEGER NOT NULL DEFAULT 0,
  latest_date       TEXT,
  artifact_uri      TEXT,
  artifact_path     TEXT,
  artifact_checksum TEXT,
  last_run_id       TEXT NOT NULL,
  attempt_count     INTEGER NOT NULL DEFAULT 1,
  error_code        TEXT,
  error_message     TEXT,
  generated_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json     TEXT,
  PRIMARY KEY(target_date, lane, field, api_key)
);
CREATE TABLE s12_replay_trade_outcomes (
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
  created_at            TEXT NOT NULL DEFAULT (datetime('now')), signal_date TEXT,
  UNIQUE(symbol, trade_date, setup_id)
);
CREATE TABLE strategy_threshold_calibration_runs (
  run_id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK(cadence IN ('daily_drift','weekly','monthly','regime_shift')),
  status TEXT NOT NULL CHECK(status IN ('success','partial','skipped','failed')),
  specs_seen INTEGER NOT NULL DEFAULT 0,
  artifacts_written INTEGER NOT NULL DEFAULT 0,
  guardrails_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE strategy_threshold_calibration_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  target_key TEXT NOT NULL DEFAULT 'featureRefs.weightedScore.min',
  status TEXT NOT NULL CHECK(status IN ('approved','rejected','frozen','rolled_back')),
  cadence TEXT NOT NULL CHECK(cadence IN ('daily_drift','weekly','monthly','regime_shift')),
  base_min REAL NOT NULL,
  previous_min REAL,
  calibrated_min REAL NOT NULL,
  delta REAL NOT NULL,
  validation_start TEXT NOT NULL,
  validation_end TEXT NOT NULL,
  guardrails_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  superseded_at TEXT
);
CREATE TABLE s12_structure_snapshots (
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
CREATE TABLE allocator_ev_feature_snapshots (
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
  snapshot_source             TEXT NOT NULL DEFAULT 'allocator_ev_asof_backfill_v1',
  l4_model_version            TEXT,
  s12_source                  TEXT,
  as_of_guard                 TEXT NOT NULL,
  source_recommendation_date  TEXT,
  generated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, lineage_cohort_id TEXT, generation_mode TEXT NOT NULL DEFAULT 'native', model_set_signature TEXT, target_semantic_version TEXT,
  PRIMARY KEY (snapshot_date, stock_id, snapshot_source)
);
CREATE TABLE s12_tw_calibration_runs (
  run_id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  cadence TEXT NOT NULL,
  status TEXT NOT NULL,
  scopes_seen INTEGER NOT NULL DEFAULT 0,
  artifacts_written INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE s12_tw_calibration_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cadence TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  alpha_bucket TEXT,
  entry_time_bucket TEXT,
  policy_json TEXT NOT NULL,
  exit_json TEXT NOT NULL,
  validation_start TEXT NOT NULL,
  validation_end TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  date_count INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  superseded_at TEXT
, entry_cohort TEXT NOT NULL DEFAULT 'legacy_mixed');
CREATE TABLE broker_execution_intents (
  intent_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy','sell')),
  status TEXT NOT NULL CHECK(status IN (
    'RESERVED','REVALIDATED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED',
    'FILLED','CANCELLED','REJECTED','UNKNOWN','BLOCKED'
  )),
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
CREATE TABLE broker_execution_legs (
  leg_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES broker_execution_intents(intent_id),
  leg_key TEXT NOT NULL,
  client_tag TEXT NOT NULL UNIQUE,
  lot_type TEXT NOT NULL CHECK(lot_type IN ('board_lot','odd_lot')),
  requested_shares INTEGER NOT NULL,
  broker_quantity INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'RESERVED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED',
    'CANCELLED','REJECTED','UNKNOWN'
  )),
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
CREATE TABLE broker_execution_events (
  event_id TEXT PRIMARY KEY,
  intent_id TEXT,
  leg_id TEXT,
  broker_order_id TEXT,
  client_tag TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'INTENT_RESERVED','LEG_CLAIMED','SUBMIT_ACK','SUBMIT_UNKNOWN','SUBMIT_REJECTED',
    'ORDER_CALLBACK','DEAL_CALLBACK','STATUS_RECONCILIATION','CONNECTION_STATE','RECOVERY'
  )),
  event_status TEXT NOT NULL,
  event_time TEXT NOT NULL,
  exchange_sequence TEXT,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(intent_id) REFERENCES broker_execution_intents(intent_id),
  FOREIGN KEY(leg_id) REFERENCES broker_execution_legs(leg_id)
);
CREATE TABLE pipeline_runs (
  run_id TEXT PRIMARY KEY,
  logical_run_key TEXT NOT NULL,
  domain TEXT NOT NULL,
  business_date TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'TW',
  mode TEXT NOT NULL DEFAULT 'production',
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'writing','validating','ready','canonical','superseded','failed','reused'
  )),
  input_fingerprint TEXT NOT NULL,
  code_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  artifact_id TEXT,
  supersedes_run_id TEXT,
  reused_from_run_id TEXT,
  parent_run_ids_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  canonical_at TEXT,
  superseded_at TEXT
);
CREATE TABLE canonical_run_heads (
  logical_run_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  previous_run_id TEXT,
  promoted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE run_artifacts (
  artifact_id TEXT PRIMARY KEY,
  retention_class TEXT NOT NULL CHECK(retention_class IN (
    'canonical_execution','canonical_model_evidence','paper_shadow',
    'superseded_run','failed_debug','request_debug','raw_market_unreferenced',
    'staging_orphan','incident_pinned'
  )),
  status TEXT NOT NULL CHECK(status IN (
    'writing','validating','ready','integrity_blocked','payload_deleted'
  )),
  domain TEXT NOT NULL,
  business_date TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  canonical_run_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  retain_until TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
  hard_ref_count INTEGER NOT NULL DEFAULT 0,
  checksum_verified_at TEXT,
  payload_deleted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE artifact_cleanup_cursors (
  task TEXT PRIMARY KEY,
  cursor_value TEXT,
  status TEXT NOT NULL CHECK(status IN ('idle','running','failed','complete')),
  processed_rows INTEGER NOT NULL DEFAULT 0,
  processed_bytes INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE artifact_d1_scrub_queue (
  scrub_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_pk_column TEXT NOT NULL,
  target_pk_value TEXT NOT NULL,
  target_column TEXT NOT NULL,
  replacement_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','running','complete','failed','integrity_blocked'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE artifact_cleanup_dlq (
  dlq_id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  artifact_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','resolved','blocked')),
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE strategy_candidate_contexts (
  context_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  raw_signals_json TEXT NOT NULL DEFAULT '{}',
  current_price REAL,
  industry TEXT,
  artifact_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, symbol, context_hash)
);
CREATE TABLE input_snapshots (
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
CREATE TABLE feature_versions (
  feature_version TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  feature_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE features (
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
CREATE TABLE strategy_versions (
  strategy_version TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  strategy_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE strategies (
  strategy_version TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  card_json TEXT NOT NULL,
  card_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_version, strategy_id)
);
CREATE TABLE analysis_runs (
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
CREATE TABLE workflow_steps (
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
CREATE TABLE workflow_checkpoints (
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
CREATE TABLE model_calls (
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
CREATE TABLE feature_clusters (
  run_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  cluster_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, cluster_id)
);
CREATE TABLE gap_maps (
  run_id TEXT PRIMARY KEY,
  gap_map_json TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE hypotheses (
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
CREATE TABLE candidates (
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
CREATE TABLE candidate_lineage (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  parent_strategy_id TEXT,
  mutation_type TEXT,
  search_mode TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);
CREATE TABLE static_validation_results (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),
  errors_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  candidate_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);
CREATE TABLE audit_issues (
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
CREATE TABLE cross_examinations (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  status TEXT NOT NULL,
  examination_json TEXT NOT NULL,
  source_model TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, issue_id)
);
CREATE TABLE artifacts (
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
CREATE TABLE codex_imports (
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
CREATE TABLE strategy_verdicts (
  run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, strategy_id)
);
CREATE TABLE candidate_verdicts (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);
CREATE TABLE issue_verdicts (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  severity TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, issue_id)
);
CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE model_champion_history (
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
CREATE TABLE allocator_ev_snapshot_runs (
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
CREATE TABLE allocator_ev_feature_snapshot_staging (
  run_id                      TEXT NOT NULL,
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
  snapshot_source             TEXT NOT NULL,
  l4_model_version            TEXT,
  s12_source                  TEXT,
  as_of_guard                 TEXT NOT NULL,
  source_recommendation_date  TEXT,
  generated_at                TEXT NOT NULL, lineage_cohort_id TEXT, generation_mode TEXT NOT NULL DEFAULT 'native', model_set_signature TEXT, target_semantic_version TEXT,
  PRIMARY KEY (run_id, stock_id),
  FOREIGN KEY (run_id) REFERENCES allocator_ev_snapshot_runs(run_id) ON DELETE CASCADE
);
CREATE TABLE artifact_hard_references (
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
CREATE TABLE allocator_ev_daily_lifecycle (
  business_date TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  native_lineage_rows INTEGER NOT NULL DEFAULT 0,
  snapshot_run_id TEXT,
  snapshot_rows INTEGER NOT NULL DEFAULT 0,
  replay_rows INTEGER NOT NULL DEFAULT 0,
  replay_maturity_as_of_date TEXT,
  upstream_run_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);
CREATE TABLE intraday_minute_bars (
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  minute_start TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  session_epoch INTEGER,
  source_event_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trade_date, symbol, minute_start)
);
CREATE TABLE active8_oof_cohorts (
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, prediction_storage_mode TEXT NOT NULL DEFAULT 'd1_full_v1', parent_cohort_id TEXT, parent_manifest_checksum TEXT);
CREATE TABLE active8_oof_predictions (
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
CREATE TABLE allocator_ev_oof_snapshots (
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
CREATE TABLE l4_oof_predictions (
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
CREATE TABLE active8_oof_fold_artifacts (
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
CREATE TABLE paper_exit_intents (
  intent_key TEXT NOT NULL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entry_date TEXT,
  requested_shares INTEGER NOT NULL,
  remaining_shares INTEGER NOT NULL,
  stop_price REAL NOT NULL,
  stop_version TEXT NOT NULL,
  trigger_price REAL NOT NULL,
  trigger_time TEXT,
  received_at TEXT NOT NULL,
  session_epoch INTEGER,
  trigger_source TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'EXIT_TRIGGERED_WAITING_BOOK'
    CHECK (state IN (
      'EXIT_TRIGGERED_WAITING_BOOK',
      'SUBMITTING',
      'PARTIAL',
      'FILLED',
      'CANCELLED',
      'SUPERSEDED'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  resolution_order_id INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE active8_oof_materialized_artifacts (
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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, eligibility_policy_version TEXT NOT NULL DEFAULT 'legacy-unversioned', date_set_checksum TEXT, replacement_reason TEXT,
  PRIMARY KEY (cohort_id, artifact_kind),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(min_date IS NULL OR max_date IS NULL OR min_date <= max_date)
);
CREATE TABLE IF NOT EXISTS "model_artifact_registry" (
  artifact_id                 TEXT PRIMARY KEY,
  model_name                  TEXT NOT NULL,
  version                     TEXT NOT NULL,
  candidate_type              TEXT NOT NULL CHECK(candidate_type IN ('monthly_release','weekly_drift','oof_full_fit_release','manual_hotfix','model_family_shadow','research_benchmark','timesfm_l175_l2_feature_release','l4_alpha_ev_refresh','allocator_ev_fusion_refresh','unknown')),
  state                       TEXT NOT NULL CHECK(state IN (
    'registered','registration_failed','offline_failed','offline_passed_weak',
    'offline_passed','offline_strong_pass','candidate_selected','shadowing',
    'live_gate_passed','approval_required','approved','production','rejected','archived'
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
CREATE TABLE selection_reference_snapshots_v1 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  stock_id INTEGER,
  name TEXT,
  market_segment TEXT,
  sector TEXT,
  hard_gate_passed INTEGER NOT NULL CHECK(hard_gate_passed IN (0, 1)),
  hard_gate_reason TEXT NOT NULL,
  feature_available INTEGER NOT NULL CHECK(feature_available IN (0, 1)),
  feature_rejection_reason TEXT,
  strategy_labeled INTEGER NOT NULL CHECK(strategy_labeled IN (0, 1)),
  strategy_selected INTEGER NOT NULL CHECK(strategy_selected IN (0, 1)),
  ml_selected INTEGER NOT NULL DEFAULT 0 CHECK(ml_selected IN (0, 1)),
  l4_selected INTEGER NOT NULL DEFAULT 0 CHECK(l4_selected IN (0, 1)),
  ev_owner_available INTEGER NOT NULL DEFAULT 0 CHECK(ev_owner_available IN (0, 1)),
  final_signal TEXT,
  selection_stage TEXT NOT NULL,
  rejection_reason TEXT,
  selection_propensity REAL,
  score_v2 REAL,
  score_components TEXT,
  allocation_selected INTEGER NOT NULL DEFAULT 0 CHECK(allocation_selected IN (0, 1)),
  decision_evidence_reconciled_at TEXT,
  strategy_labeler_version TEXT,
  strategy_router_version TEXT,
  strategy_registry_checksum TEXT NOT NULL,
  feature_contract_version TEXT NOT NULL,
  evidence_artifact_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reference_source TEXT NOT NULL DEFAULT 'native'
  CHECK(reference_source IN ('native', 'historical_reconstruction')), strategy_matrix_status TEXT NOT NULL DEFAULT 'ready'
  CHECK(strategy_matrix_status IN ('ready', 'unavailable')), reconstruction_reason TEXT, source_artifact_checksum TEXT,
  PRIMARY KEY(signal_date, symbol, producer_run_id)
);
CREATE TABLE strategy_label_matrix_v4 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  strategy_status TEXT NOT NULL,
  alpha_bucket TEXT NOT NULL,
  family_id TEXT NOT NULL,
  production_owner INTEGER NOT NULL CHECK(production_owner IN (0, 1)),
  strategy_hit INTEGER NOT NULL CHECK(strategy_hit IN (0, 1)),
  weak_label REAL NOT NULL,
  affinity REAL NOT NULL,
  position_weight REAL NOT NULL,
  overlap REAL NOT NULL,
  label_reason TEXT,
  labeler_version TEXT NOT NULL,
  strategy_registry_checksum TEXT NOT NULL,
  reference_contract_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol, producer_run_id, strategy_id, strategy_version)
);
CREATE TABLE strategy_label_matrix_runs_v4 (
  producer_run_id TEXT PRIMARY KEY,
  signal_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing', 'ready', 'failed')),
  reference_candidate_count INTEGER NOT NULL,
  strategy_count INTEGER NOT NULL,
  expected_cell_count INTEGER NOT NULL,
  persisted_cell_count INTEGER NOT NULL DEFAULT 0,
  strategy_registry_checksum TEXT NOT NULL,
  labeler_version TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE canonical_selection_labels_v4 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  label_schema_version TEXT NOT NULL DEFAULT 'canonical-strategy-selection-label-v4',
  producer_run_id TEXT NOT NULL,
  market_segment TEXT,
  sector TEXT,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  outcome_known_date TEXT NOT NULL,
  entry_raw_open REAL NOT NULL,
  exit_raw_close REAL NOT NULL,
  entry_adjustment_factor REAL NOT NULL,
  exit_adjustment_factor REAL NOT NULL,
  gross_return REAL NOT NULL,
  transaction_cost_bps REAL NOT NULL,
  absolute_return_net REAL NOT NULL,
  benchmark_return_net REAL NOT NULL,
  benchmark_scope TEXT NOT NULL CHECK(benchmark_scope IN ('sector','market_segment','market')),
  residual_return_net REAL NOT NULL,
  cross_section_rank REAL NOT NULL,
  adjustment_source TEXT NOT NULL,
  reference_contract_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol, producer_run_id, label_schema_version),
  CHECK(entry_date > signal_date),
  CHECK(exit_date >= entry_date),
  CHECK(outcome_known_date = exit_date)
);
CREATE TABLE canonical_selection_label_rejections_v4 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol, producer_run_id, reason_code)
);
CREATE TABLE canonical_selection_label_runs_v4 (
  run_id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
  reference_rows INTEGER NOT NULL,
  mature_rows INTEGER NOT NULL,
  pending_rows INTEGER NOT NULL,
  unavailable_rows INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE strategy_marginal_edge_runs_v4 (
  run_id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('shadow','promoted','failed')),
  strategy_count INTEGER NOT NULL,
  eligible_strategy_count INTEGER NOT NULL,
  sample_dates INTEGER NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE strategy_marginal_edge_v4 (
  run_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  edge_schema_version TEXT NOT NULL DEFAULT 'strategy-marginal-edge-v4',
  observation_dates INTEGER NOT NULL,
  candidate_observations INTEGER NOT NULL,
  marginal_edge_mean REAL,
  marginal_edge_lcb90 REAL,
  positive_date_rate REAL,
  absolute_hit_return_mean REAL,
  production_eligible INTEGER NOT NULL DEFAULT 0 CHECK(production_eligible IN (0,1)),
  production_weight_raw REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, strategy_id, strategy_version),
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);
CREATE TABLE strategy_marginal_edge_dates_v4 (
  run_id TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  candidate_residual_return REAL,
  candidate_absolute_return REAL,
  champion_residual_return REAL,
  champion_absolute_return REAL,
  paired_residual_delta REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, signal_date),
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);
CREATE TABLE strategy_marginal_edge_head_v4 (
  owner_key TEXT PRIMARY KEY CHECK(owner_key = 'production'),
  run_id TEXT NOT NULL,
  previous_run_id TEXT,
  promoted_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);
CREATE TABLE pipeline_stage_runs (
  business_date TEXT NOT NULL,
  stage TEXT NOT NULL,
  canonical_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'success', 'error')),
  cursor_key TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  expected_count INTEGER,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(business_date, stage)
);
CREATE TABLE strategy_learning_runs (
  business_date TEXT PRIMARY KEY,
  canonical_run_id TEXT NOT NULL,
  producer_run_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'success', 'error')),
  cursor_symbol TEXT,
  expected_candidates INTEGER,
  processed_candidates INTEGER NOT NULL DEFAULT 0,
  strategy_count INTEGER,
  expected_decision_rows INTEGER,
  persisted_decision_rows INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE TABLE maintenance_task_leases (
  lease_group TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE legacy_migration_cursors (
  task_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'error')),
  cursor_date TEXT,
  cursor_key TEXT,
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE domain_projection_outbox (
  event_id TEXT PRIMARY KEY,
  source_domain TEXT NOT NULL,
  target_domain TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  business_date TEXT,
  payload_json TEXT,
  payload_artifact_id TEXT,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'publishing', 'published', 'error')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE domain_projection_inbox (
  target_domain TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(target_domain, event_id)
);
CREATE TABLE data_domain_cutovers (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('legacy', 'shadow', 'read_cutover', 'write_cutover', 'complete', 'rollback')),
  source_binding TEXT NOT NULL DEFAULT 'DB',
  target_binding TEXT,
  source_row_count INTEGER,
  target_row_count INTEGER,
  source_checksum TEXT,
  target_checksum TEXT,
  parity_checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE data_retention_policies (
  policy_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  dataset_pattern TEXT NOT NULL,
  hot_retention_days INTEGER NOT NULL,
  cold_retention_days INTEGER,
  archive_store TEXT NOT NULL CHECK(archive_store IN ('r2', 'gcs', 'none')),
  action TEXT NOT NULL CHECK(action IN ('archive_scrub', 'archive_delete', 'delete_unreferenced', 'retain')),
  hard_reference_protected INTEGER NOT NULL DEFAULT 1 CHECK(hard_reference_protected IN (0, 1)),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'retired')),
  approved_reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE data_retention_runs (
  run_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'skipped')),
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  archived_bytes INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY(policy_id) REFERENCES data_retention_policies(policy_id)
);
CREATE TABLE storage_capacity_daily (
  observed_date TEXT NOT NULL,
  domain TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  used_bytes INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  utilization_pct REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'warning', 'drain', 'critical')),
  measurement_source TEXT NOT NULL CHECK(measurement_source = 'd1_result_meta_size_after'),
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(observed_date, domain, binding_name)
);
CREATE TABLE market_trading_sessions (
  session_date TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  materialized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(sample_size > 0)
);
CREATE TABLE price_horizon_labels_v1 (
  stock_id INTEGER NOT NULL,
  price_date TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  entry_raw_open REAL NOT NULL,
  entry_adjustment_factor REAL NOT NULL,
  exit_date TEXT NOT NULL,
  exit_raw_close REAL NOT NULL,
  exit_adjustment_factor REAL NOT NULL,
  outcome_known_date TEXT NOT NULL,
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  materialized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, price_date),
  CHECK(entry_date > price_date),
  CHECK(exit_date >= entry_date),
  CHECK(outcome_known_date = exit_date),
  CHECK(entry_raw_open > 0),
  CHECK(exit_raw_close > 0),
  CHECK(entry_adjustment_factor > 0),
  CHECK(exit_adjustment_factor > 0)
);
CREATE TABLE price_horizon_label_rejections_v1 (
  stock_id INTEGER NOT NULL,
  price_date TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, price_date)
);
CREATE TABLE price_horizon_projection_status (
  signal_date TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  materialized_count INTEGER NOT NULL,
  rejected_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success', 'incomplete', 'empty')),
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(candidate_count >= 0),
  CHECK(materialized_count >= 0),
  CHECK(rejected_count >= 0),
  CHECK(materialized_count + rejected_count = candidate_count)
);
CREATE TABLE price_horizon_projection_runs (
  run_id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  outcome_as_of_date TEXT NOT NULL,
  eligible_signal_dates INTEGER NOT NULL DEFAULT 0,
  processed_signal_dates INTEGER NOT NULL DEFAULT 0,
  skipped_complete_dates INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  materialized_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'complete_with_rejections', 'error')),
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE TABLE data_domain_backfill_cursors (
  domain TEXT NOT NULL,
  table_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','error')),
  cursor_json TEXT,
  rows_copied INTEGER NOT NULL DEFAULT 0,
  last_batch_rows INTEGER NOT NULL DEFAULT 0,
  last_source_checksum TEXT,
  last_target_checksum TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(domain, table_name)
);
CREATE TABLE data_domain_parity_checks (
  check_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  table_name TEXT NOT NULL,
  check_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','fail','blocked')),
  source_count INTEGER,
  target_count INTEGER,
  source_checksum TEXT,
  target_checksum TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE selection_reference_repair_runs_v1 (
  signal_date TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing', 'ready', 'failed')),
  expected_rows INTEGER NOT NULL,
  persisted_rows INTEGER NOT NULL DEFAULT 0,
  source_artifact_id TEXT NOT NULL,
  source_artifact_checksum TEXT NOT NULL,
  source_artifact_schema TEXT NOT NULL,
  strategy_matrix_status TEXT NOT NULL CHECK(strategy_matrix_status IN ('ready', 'unavailable')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, producer_run_id)
);
CREATE TABLE active8_oof_retention_ledger (
  cohort_id TEXT PRIMARY KEY,
  legality_state TEXT NOT NULL CHECK(legality_state IN ('legal', 'mixed', 'illegal', 'pending')),
  retention_action TEXT NOT NULL CHECK(retention_action IN ('retain_hot', 'archive_required', 'archive_only', 'delete_hot')),
  status TEXT NOT NULL CHECK(status IN ('planned', 'blocked', 'archived', 'verified', 'deleted', 'error')),
  d1_prediction_rows INTEGER NOT NULL DEFAULT 0,
  d1_snapshot_rows INTEGER NOT NULL DEFAULT 0,
  d1_l4_rows INTEGER NOT NULL DEFAULT 0,
  hard_reference_count INTEGER NOT NULL DEFAULT 0,
  archive_store TEXT CHECK(archive_store IN ('r2', 'gcs')),
  archive_path TEXT,
  archive_checksum TEXT,
  archive_row_count INTEGER,
  archive_verified_at TEXT,
  blocker_reason TEXT,
  planned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE active8_oof_materialized_artifact_history (
  cohort_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  format_version TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  date_count INTEGER NOT NULL,
  min_date TEXT,
  max_date TEXT,
  compressed_bytes INTEGER NOT NULL,
  uncompressed_bytes INTEGER NOT NULL,
  source_manifest_checksum TEXT NOT NULL,
  eligibility_policy_version TEXT NOT NULL,
  date_set_checksum TEXT,
  replaced_by_checksum TEXT NOT NULL,
  replacement_reason TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, artifact_kind, artifact_checksum),
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(length(replaced_by_checksum) = 64),
  CHECK(date_set_checksum IS NULL OR length(date_set_checksum) = 64)
);
CREATE TABLE IF NOT EXISTS "active8_oof_date_eligibility" (
  cohort_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  evidence_scope TEXT NOT NULL CHECK(evidence_scope IN ('active8_oof','snapshot','l4','fusion')),
  eligibility_status TEXT NOT NULL CHECK(eligibility_status IN ('legal','illegal','pending')),
  reason_code TEXT NOT NULL,
  evidence_schema_version TEXT NOT NULL,
  source_manifest_checksum TEXT,
  evidence_artifact_path TEXT,
  evidence_artifact_checksum TEXT,
  assessed_knowledge_cutoff TEXT NOT NULL,
  assessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(cohort_id, prediction_date, evidence_scope)
);
CREATE TABLE data_retention_cursors (
  policy_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','cycle_complete','error')),
  cursor_date TEXT,
  cursor_key TEXT,
  cycle INTEGER NOT NULL DEFAULT 0,
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  backlog_remaining INTEGER NOT NULL DEFAULT 1 CHECK(backlog_remaining IN (0,1)),
  last_run_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(policy_id, dataset_id),
  FOREIGN KEY(policy_id) REFERENCES data_retention_policies(policy_id)
);
CREATE TABLE data_retention_run_items (
  run_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','error','skipped')),
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  archived_bytes INTEGER NOT NULL DEFAULT 0,
  cursor_date TEXT,
  cursor_key TEXT,
  backlog_remaining INTEGER NOT NULL DEFAULT 0 CHECK(backlog_remaining IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, dataset_id),
  FOREIGN KEY(run_id) REFERENCES data_retention_runs(run_id)
);
CREATE TABLE s12_structure_batch_runs (
  run_id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('evening_chain','historical_shadow','manual_repair')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  setup_waiting_count INTEGER NOT NULL DEFAULT 0,
  risk_blocked_count INTEGER NOT NULL DEFAULT 0,
  invalidated_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  shard_count INTEGER NOT NULL DEFAULT 0,
  completed_shards INTEGER NOT NULL DEFAULT 0,
  artifact_id TEXT,
  artifact_checksum TEXT,
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(artifact_checksum IS NULL OR artifact_checksum GLOB 'sha256:[0-9a-f]*')
);
CREATE TABLE s12_structure_batch_shards (
  run_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  first_symbol TEXT,
  last_symbol TEXT,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  attempt INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  setup_waiting_count INTEGER NOT NULL DEFAULT 0,
  risk_blocked_count INTEGER NOT NULL DEFAULT 0,
  invalidated_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, shard_index),
  FOREIGN KEY(run_id) REFERENCES s12_structure_batch_runs(run_id)
);
CREATE TABLE s12_formal_ev_decisions (
  decision_id TEXT PRIMARY KEY,
  observation_date TEXT NOT NULL,
  source_trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  structure_snapshot_id INTEGER,
  structure_state TEXT NOT NULL,
  structure_class TEXT NOT NULL CHECK(structure_class IN (
    'execution_ready','setup_waiting','risk_blocked','invalidated','unavailable'
  )),
  s12_ev_status TEXT NOT NULL,
  expected_return_owner TEXT,
  expected_return REAL,
  uncertainty_adjusted_expected_return REAL,
  action TEXT NOT NULL CHECK(action IN ('potential_buy','hold','abstain')),
  reason_code TEXT NOT NULL,
  l4_model_version TEXT,
  fusion_model_version TEXT,
  s12_artifact_id TEXT,
  producer_run_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(observation_date, source_trade_date, symbol, producer_run_id),
  CHECK(json_valid(evidence_json))
);
CREATE TABLE expected_return_artifact_payloads (
  artifact_id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL CHECK(model_name IN ('l4_alpha_ev','allocator_ev_fusion')),
  model_version TEXT NOT NULL,
  serving_mode TEXT NOT NULL CHECK(serving_mode IN ('alpha','abstention_baseline')),
  artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64),
  source_artifact_path TEXT,
  source_artifact_checksum TEXT,
  source_cohort_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(artifact_id) REFERENCES model_artifact_registry(artifact_id) ON DELETE RESTRICT,
  UNIQUE(model_name, model_version)
);
CREATE TABLE strategy_learning_daily_stats (
  date TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  decisions INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  reward_samples INTEGER NOT NULL DEFAULT 0,
  reward_hits INTEGER NOT NULL DEFAULT 0,
  reward_sum REAL NOT NULL DEFAULT 0,
  date_portfolio_return REAL,
  reward_refresh_run_id TEXT,
  projection_version TEXT NOT NULL DEFAULT 'strategy-learning-daily-v1',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, evaluable_decisions INTEGER NOT NULL DEFAULT 0, unavailable_decisions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(date, strategy_id, strategy_version)
);
CREATE TABLE strategy_learning_head (
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  lifetime_decisions INTEGER NOT NULL DEFAULT 0,
  lifetime_matched INTEGER NOT NULL DEFAULT 0,
  decision_dates INTEGER NOT NULL DEFAULT 0,
  lifetime_reward_samples INTEGER NOT NULL DEFAULT 0,
  lifetime_reward_hits INTEGER NOT NULL DEFAULT 0,
  lifetime_reward_sum REAL NOT NULL DEFAULT 0,
  reward_dates INTEGER NOT NULL DEFAULT 0,
  latest_decision_date TEXT,
  latest_reward_date TEXT,
  projection_version TEXT NOT NULL DEFAULT 'strategy-learning-head-v1',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, lifetime_evaluable_decisions INTEGER NOT NULL DEFAULT 0, lifetime_unavailable_decisions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(strategy_id, strategy_version)
);
CREATE TABLE strategy_evidence_rebuild_runs_v5 (signal_date TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','success','blocked','failed')), candidate_count INTEGER NOT NULL DEFAULT 0, strategy_count INTEGER NOT NULL DEFAULT 0, decision_rows INTEGER NOT NULL DEFAULT 0, evaluable_rows INTEGER NOT NULL DEFAULT 0, unavailable_rows INTEGER NOT NULL DEFAULT 0, matrix_rows INTEGER NOT NULL DEFAULT 0, labeler_version TEXT NOT NULL DEFAULT 'strategy-decision-log-pit-reconstruction-v5', source_checksum TEXT, blocker_reason TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE strategy_replacement_decisions_v5 (decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, as_of_date TEXT NOT NULL, family_id TEXT NOT NULL, candidate_strategy_id TEXT NOT NULL, candidate_strategy_version TEXT NOT NULL, replaced_strategy_id TEXT NOT NULL, replaced_strategy_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected')), paired_dates INTEGER NOT NULL DEFAULT 0, paired_delta_mean REAL, paired_delta_lcb90 REAL, candidate_absolute_mean REAL, candidate_max_drawdown REAL, replaced_max_drawdown REAL, candidate_turnover REAL, replaced_turnover REAL, return_correlation REAL, evidence_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(run_id, candidate_strategy_id, candidate_strategy_version, replaced_strategy_id, replaced_strategy_version), CHECK(json_valid(evidence_json)));
CREATE TABLE strategy_replacement_cutover_guards_v5 (guard_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('pre','post','portfolio_post')), precondition_ok INTEGER NOT NULL CHECK(precondition_ok=1), evidence_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(json_valid(evidence_json)));
DELETE FROM sqlite_sequence;
CREATE INDEX idx_users_google ON users(google_id);
CREATE INDEX idx_stocks_symbol ON stocks(symbol);
CREATE INDEX idx_prices_stock_date ON stock_prices(stock_id, date);
CREATE INDEX idx_ti_stock_date ON technical_indicators(stock_id, date);
CREATE INDEX idx_fin_stock_period ON financials(stock_id, period);
CREATE INDEX idx_news_stock_date ON news(stock_id, published_at);
CREATE INDEX idx_pred_stock    ON predictions(stock_id, model_name);
CREATE INDEX idx_pred_verify   ON predictions(stock_id, verified_at);
CREATE INDEX idx_pred_unverify ON predictions(stock_id, direction_correct) WHERE direction_correct IS NULL;
CREATE INDEX idx_model_acc ON model_accuracy(stock_id, model_name);
CREATE INDEX idx_memories_stock ON stock_memories(stock_id, memory_type);
CREATE INDEX idx_wl_user_stock ON watchlist(user_id, stock_id);
CREATE INDEX idx_alerts_user ON alert_rules(user_id);
CREATE INDEX idx_alerts_active ON alert_rules(is_active);
CREATE INDEX idx_market_risk_date ON market_risk(date);
CREATE INDEX idx_trade_perf ON trade_performance(stock_id, model_name);
CREATE INDEX idx_system_logs ON system_logs(created_at DESC);
CREATE INDEX idx_chat_sessions ON chat_sessions(user_id, stock_id, updated_at DESC);
CREATE INDEX idx_chat_messages ON chat_messages(session_id, created_at);
CREATE INDEX idx_notif_user_read ON alert_notifications(user_id, is_read);
CREATE INDEX idx_rec_date ON daily_recommendations(date DESC);
CREATE INDEX idx_paper_orders_account ON paper_orders(account_id, created_at DESC);
CREATE INDEX idx_paper_orders_symbol  ON paper_orders(symbol, created_at DESC);
CREATE INDEX idx_paper_snapshots ON paper_daily_snapshots(account_id, date DESC);
CREATE INDEX idx_sector_heat_date ON sector_heat(date DESC, score DESC);
CREATE INDEX idx_stock_tags_symbol ON stock_tags(symbol);
CREATE INDEX idx_stock_tags_tag ON stock_tags(tag);
CREATE INDEX idx_concept_buzz_date ON concept_buzz(date DESC);
CREATE INDEX idx_monthly_revenue_stock_date ON monthly_revenue(stock_id, date);
CREATE INDEX idx_margin_data_stock_date ON margin_data(stock_id, date);
CREATE INDEX idx_shareholding_stock_date ON shareholding(stock_id, date);
CREATE INDEX idx_stock_profiles_symbol ON stock_profiles(symbol);
CREATE INDEX idx_sfs_date_theme ON sector_flow_stocks(date, theme);
CREATE INDEX idx_sfs_date_class ON sector_flow_stocks(date, classification);
CREATE INDEX idx_chip_symbol_date ON chip_data(symbol, date);
CREATE INDEX idx_decision_logs_date ON decision_logs(date DESC);
CREATE INDEX idx_model_health_date ON model_health_daily(date DESC);
CREATE INDEX idx_lifecycle_events_date ON model_lifecycle_events(event_date DESC);
CREATE INDEX idx_sector_flow_date ON sector_flow(date DESC, total_net DESC);
CREATE INDEX idx_settlements_pending ON paper_settlements(settled, settlement_date);
CREATE INDEX idx_settlements_account ON paper_settlements(account_id, settled);
CREATE INDEX idx_momentum_snapshots_date
  ON screener_momentum_snapshots(date DESC);
CREATE INDEX idx_persona_opinions_date
  ON persona_opinions(date DESC);
CREATE INDEX idx_webhook_log_received ON webhook_log(received_at);
CREATE INDEX idx_webhook_log_action   ON webhook_log(action);
CREATE INDEX idx_debate_memory_sym_date ON debate_memory(symbol, debate_date DESC);
CREATE INDEX idx_debate_memory_date     ON debate_memory(debate_date);
CREATE INDEX idx_config_lifecycle_events_date ON config_lifecycle_events(event_date DESC);
CREATE INDEX idx_config_lifecycle_events_type ON config_lifecycle_events(event_type, event_date DESC);
CREATE INDEX idx_exit_shadow_date   ON exit_shadow_log(date DESC);
CREATE INDEX idx_exit_shadow_regime ON exit_shadow_log(regime, date DESC);
CREATE INDEX idx_exit_shadow_symbol ON exit_shadow_log(symbol, date DESC);
CREATE INDEX idx_screener_hist_date   ON screener_selection_history(date DESC);
CREATE INDEX idx_screener_hist_symbol ON screener_selection_history(symbol, date DESC);
CREATE INDEX idx_sector_leaders_symbol ON sector_leaders(symbol);
CREATE INDEX idx_risk_audit_ts       ON risk_audit_log(timestamp DESC);
CREATE INDEX idx_risk_audit_halt     ON risk_audit_log(halt, timestamp DESC);
CREATE INDEX idx_risk_audit_sev      ON risk_audit_log(severity, timestamp DESC);
CREATE INDEX idx_risk_audit_trigger  ON risk_audit_log(trigger_event, timestamp DESC);
CREATE INDEX idx_risk_audit_symbol   ON risk_audit_log(symbol, timestamp DESC);
CREATE INDEX idx_cost_events_date     ON cost_events(date DESC);
CREATE INDEX idx_cost_events_source   ON cost_events(source, date DESC);
CREATE INDEX idx_cost_events_provider ON cost_events(provider, date DESC);
CREATE INDEX idx_debate_ab_date   ON debate_ab_log(date DESC);
CREATE INDEX idx_debate_ab_model  ON debate_ab_log(model_assigned, date DESC);
CREATE INDEX idx_debate_ab_symbol ON debate_ab_log(symbol, date DESC);
CREATE INDEX idx_pending_buy_runs_trade_date
  ON pending_buy_runs(trade_date, id DESC);
CREATE INDEX idx_pending_buy_runs_status
  ON pending_buy_runs(status, trade_date DESC);
CREATE INDEX idx_pending_buy_items_run
  ON pending_buy_items(run_id, score DESC, confidence DESC);
CREATE INDEX idx_pending_buy_items_symbol
  ON pending_buy_items(symbol, created_at DESC);
CREATE INDEX idx_pending_buy_items_execution
  ON pending_buy_items(execution_status, debate_status, symbol);
CREATE UNIQUE INDEX idx_paper_order_intents_unique
  ON paper_order_intents(account_id, trade_date, symbol, side, source);
CREATE INDEX idx_paper_order_intents_date
  ON paper_order_intents(trade_date, status);
CREATE INDEX idx_paper_execution_events_date
  ON paper_execution_events(trade_date DESC, event_type, status);
CREATE INDEX idx_paper_execution_events_symbol
  ON paper_execution_events(symbol, created_at DESC);
CREATE INDEX idx_paper_execution_events_order
  ON paper_execution_events(order_id);
CREATE INDEX idx_observability_events_date ON observability_events(date, severity, created_at DESC);
CREATE INDEX idx_observability_events_domain ON observability_events(domain, created_at DESC);
CREATE INDEX idx_stock_trading_restrictions_active_symbol
  ON stock_trading_restrictions(active, symbol);
CREATE INDEX idx_stock_trading_restrictions_dates
  ON stock_trading_restrictions(start_date, end_date);
CREATE INDEX idx_predictions_business_date
  ON predictions(prediction_date, stock_id, model_name);
CREATE INDEX idx_screener_funnel_runs_date
  ON screener_funnel_runs(date DESC, created_at DESC);
CREATE INDEX idx_screener_funnel_items_run
  ON screener_funnel_items(run_id, stage, decision);
CREATE INDEX idx_screener_funnel_items_symbol
  ON screener_funnel_items(symbol, date DESC);
CREATE INDEX idx_rec_date_rank_score
  ON daily_recommendations(date, rank, score DESC);
CREATE INDEX idx_rec_date_signal_score
  ON daily_recommendations(date, has_buy_signal, score DESC);
CREATE INDEX idx_rec_symbol_date
  ON daily_recommendations(symbol, date DESC);
CREATE INDEX idx_pred_date_model_stock
  ON predictions(prediction_date, model_name, stock_id);
CREATE INDEX idx_pred_date_stock_model_generated
  ON predictions(prediction_date, stock_id, model_name, generated_at DESC, id DESC);
CREATE INDEX idx_pred_stock_generated
  ON predictions(stock_id, generated_at DESC);
CREATE INDEX idx_pred_model_verified_date
  ON predictions(model_name, verified_at, prediction_date);
CREATE INDEX idx_prices_date_stock
  ON stock_prices(date, stock_id);
CREATE INDEX idx_ti_date_stock
  ON technical_indicators(date, stock_id);
CREATE INDEX idx_chip_date_symbol
  ON chip_data(date, symbol);
CREATE INDEX idx_model_acc_period_model
  ON model_accuracy(period, model_name);
CREATE INDEX idx_sector_flow_date_class_total
  ON sector_flow(date, classification, total_net DESC);
CREATE INDEX idx_sector_flow_stocks_date_theme_class_net
  ON sector_flow_stocks(date, theme, classification, net_amount DESC);
CREATE INDEX idx_screener_funnel_items_run_symbol_stage
  ON screener_funnel_items(run_id, symbol, stage, created_at);
CREATE INDEX idx_paper_orders_account_side_created
  ON paper_orders(account_id, side, created_at DESC);
CREATE INDEX idx_paper_positions_account_symbol_shares
  ON paper_positions(account_id, symbol, shares);
CREATE INDEX idx_paper_execution_events_account_created
  ON paper_execution_events(account_id, created_at DESC);
CREATE INDEX idx_dataset_snapshots_kind_date
  ON dataset_snapshots(kind, business_date DESC, status);
CREATE INDEX idx_dataset_snapshots_access_date
  ON dataset_snapshots(access_tier, business_date DESC, primary_store);
CREATE INDEX idx_dataset_snapshots_run
  ON dataset_snapshots(producer_run_id, kind);
CREATE INDEX idx_meta_reward_ledger_policy
  ON meta_reward_ledger(policy_id, updated_at DESC);
CREATE INDEX idx_meta_shadow_decisions_policy_date
  ON meta_shadow_decisions(policy_id, business_date DESC, created_at DESC);
CREATE INDEX idx_model_champion_pointers_updated
  ON model_champion_pointers(updated_at DESC);
CREATE INDEX idx_scheduler_locks_owner_date
  ON scheduler_locks(owner, run_date, created_at DESC);
CREATE INDEX idx_compute_profile_events_job_date
  ON compute_profile_events(job_name, event_date DESC);
CREATE INDEX idx_compute_profile_events_provider_date
  ON compute_profile_events(provider, event_date DESC);
CREATE INDEX idx_compute_efficiency_reports_job_date
  ON compute_efficiency_reports(job_name, report_date DESC);
CREATE INDEX idx_compute_efficiency_reports_decision
  ON compute_efficiency_reports(decision, report_date DESC);
CREATE INDEX idx_paper_challenger_candidates_state
  ON paper_challenger_candidates(current_state, updated_at DESC);
CREATE INDEX idx_paper_decision_attribution_symbol_date
  ON paper_decision_attribution(symbol, trade_date DESC);
CREATE INDEX idx_paper_decision_attribution_candidate
  ON paper_decision_attribution(candidate_source, trade_date DESC);
CREATE INDEX idx_paper_challenger_daily_metrics_candidate
  ON paper_challenger_daily_metrics(candidate_id, trade_date DESC);
CREATE INDEX idx_promotion_audit_events_candidate
  ON promotion_audit_events(candidate_id, created_at DESC);
CREATE INDEX idx_source_diff_report_run ON source_diff_report(run_id, dataset_lane);
CREATE INDEX idx_source_diff_report_lane ON source_diff_report(dataset_lane, generated_at DESC);
CREATE INDEX idx_gap_fill_candidates_run ON gap_fill_candidates(run_id, dataset_lane);
CREATE INDEX idx_gap_fill_candidates_key ON gap_fill_candidates(stock_id, date, field);
CREATE INDEX idx_data_source_inventory_dataset ON data_source_inventory(dataset, as_of_date DESC);
CREATE INDEX idx_source_quality_metrics_source ON source_quality_metrics(source, dataset, as_of_date DESC);
CREATE INDEX idx_external_evidence_source_date ON external_evidence_items(source_id, published_at DESC);
CREATE INDEX idx_external_evidence_accepted ON external_evidence_items(accepted, published_at DESC);
CREATE INDEX idx_theme_signals_date_score ON theme_signals(date DESC, score DESC);
CREATE INDEX idx_theme_signals_concept ON theme_signals(concept, date DESC);
CREATE INDEX idx_stock_theme_features_date_score ON stock_theme_features(date DESC, score DESC);
CREATE INDEX idx_stock_theme_features_symbol ON stock_theme_features(symbol, date DESC);
CREATE INDEX idx_canonical_broker_flow_date
  ON canonical_broker_flow_daily(date DESC, market_segment);
CREATE INDEX idx_canonical_broker_flow_symbol
  ON canonical_broker_flow_daily(stock_id, date DESC);
CREATE INDEX idx_finlab_taxonomy_tags_symbol
  ON finlab_taxonomy_tags(symbol, tag_type);
CREATE INDEX idx_finlab_taxonomy_tags_tag
  ON finlab_taxonomy_tags(tag, tag_type);
CREATE INDEX idx_canonical_trading_restrictions_active
  ON canonical_trading_restrictions(active, source_date DESC, restriction_type);
CREATE INDEX idx_canonical_trading_restrictions_symbol
  ON canonical_trading_restrictions(symbol, source_date DESC);
CREATE INDEX idx_market_regime_factor_packets_generated
  ON market_regime_factor_packets(generated_at DESC);
CREATE INDEX idx_canonical_market_date_stock
  ON canonical_market_daily(date DESC, stock_id);
CREATE INDEX idx_canonical_chip_date_segment_stock
  ON canonical_chip_daily(date DESC, market_segment, stock_id);
CREATE INDEX idx_canonical_revenue_month_stock
  ON canonical_revenue_monthly(revenue_month DESC, stock_id);
CREATE INDEX idx_margin_data_date_stock
  ON margin_data(date, stock_id);
CREATE INDEX idx_news_published_id
  ON news(published_at DESC, id DESC);
CREATE INDEX idx_news_created_id
  ON news(created_at DESC, id DESC);
CREATE INDEX idx_strategy_spec_registry_status
  ON strategy_spec_registry(status, updated_at DESC);
CREATE INDEX idx_strategy_spec_registry_bucket
  ON strategy_spec_registry(alpha_bucket, status);
CREATE INDEX idx_strategy_decision_log_date
  ON strategy_decision_log(date DESC, strategy_id, matched);
CREATE INDEX idx_strategy_decision_log_symbol
  ON strategy_decision_log(symbol, date DESC);
CREATE INDEX idx_strategy_decision_log_status
  ON strategy_decision_log(strategy_status, matched, date DESC);
CREATE INDEX idx_strategy_reward_ledger_strategy
  ON strategy_reward_ledger(strategy_id, updated_at DESC);
CREATE INDEX idx_strategy_reward_ledger_status
  ON strategy_reward_ledger(strategy_status, samples DESC);
CREATE INDEX idx_pending_buy_items_debate_status_symbol
  ON pending_buy_items(debate_status, symbol, created_at DESC);
CREATE INDEX idx_canonical_institutional_amount_daily_date
  ON canonical_institutional_amount_daily(date DESC, market_segment, investor);
CREATE INDEX idx_canonical_fundamental_features_available
  ON canonical_fundamental_features(available_date DESC, stock_id);
CREATE INDEX idx_canonical_fundamental_features_symbol_period
  ON canonical_fundamental_features(stock_id, period DESC);
CREATE INDEX idx_strategy_spec_registry_family
  ON strategy_spec_registry(family_id, status);
CREATE INDEX idx_state_space_shadow_run
  ON state_space_shadow_results(run_date, run_id);
CREATE INDEX idx_state_space_shadow_model_symbol
  ON state_space_shadow_results(model_name, symbol, run_date);
CREATE INDEX idx_state_space_shadow_errors
  ON state_space_shadow_results(run_date, model_name, error, fallback_reason);
CREATE INDEX idx_strategy_mining_runs_date ON strategy_mining_runs(run_date, cadence, status);
CREATE INDEX idx_strategy_mining_candidates_run ON strategy_mining_candidates(run_id, promotion_state, validation_status);
CREATE INDEX idx_strategy_backtest_results_candidate ON strategy_backtest_results(candidate_id, created_at DESC);
CREATE INDEX idx_strategy_similarity_matrix_run ON strategy_similarity_matrix(run_id, similarity DESC);
CREATE INDEX idx_strategy_promotion_ledger_candidate ON strategy_promotion_ledger(candidate_id, created_at DESC);
CREATE INDEX idx_active_strategy_backtest_results_strategy
  ON active_strategy_backtest_results(strategy_id, run_id, created_at DESC);
CREATE INDEX idx_pending_buy_filter_audit_run
  ON pending_buy_filter_audit(run_id, stage, action);
CREATE INDEX idx_pending_buy_filter_audit_trade_date
  ON pending_buy_filter_audit(trade_date DESC, source_reco_date, symbol);
CREATE INDEX idx_pending_buy_filter_audit_reason
  ON pending_buy_filter_audit(reason_code, trade_date DESC);
CREATE INDEX idx_sector_flow_rotation_regime
  ON sector_flow(date, classification, rotation_regime);
CREATE INDEX idx_sector_flow_rotation_score
  ON sector_flow(date, classification, rotation_score DESC);
CREATE INDEX idx_canonical_broker_rank_date
  ON canonical_broker_rank_daily(date DESC, market_segment, rank_side);
CREATE INDEX idx_canonical_broker_rank_symbol
  ON canonical_broker_rank_daily(stock_id, date DESC);
CREATE INDEX idx_canonical_institutional_amount_date
  ON canonical_institutional_amount_daily(date DESC, market_segment);
CREATE INDEX idx_canonical_market_index_symbol_date
  ON canonical_market_index_daily(symbol, date DESC);
CREATE INDEX idx_canonical_futures_symbol_date
  ON canonical_futures_daily(symbol, session, date DESC);
CREATE INDEX idx_canonical_regime_context_dataset_date
  ON canonical_regime_context_daily(dataset, date DESC);
CREATE INDEX idx_canonical_regime_context_field_date
  ON canonical_regime_context_daily(field, category, date DESC);
CREATE INDEX idx_canonical_market_summary_daily_date
  ON canonical_market_summary_daily(date DESC);
CREATE INDEX idx_canonical_fundamental_symbol_date
  ON canonical_fundamental_features(stock_id, available_date DESC, period DESC);
CREATE INDEX idx_source_key_attempts_target_lane
  ON source_key_attempts(target_date, lane, created_at DESC);
CREATE INDEX idx_source_key_attempts_run
  ON source_key_attempts(run_id, lane, field);
CREATE INDEX idx_source_key_report_target_lane
  ON source_key_report(target_date, lane, status);
CREATE INDEX idx_source_key_report_key_status
  ON source_key_report(target_date, lane, field, status);
CREATE INDEX idx_s12_replay_trade_outcomes_date
  ON s12_replay_trade_outcomes(trade_date DESC, sample_eligible, symbol);
CREATE INDEX idx_strategy_threshold_artifacts_latest
  ON strategy_threshold_calibration_artifacts(strategy_id, strategy_version, target_key, status, approved_at DESC);
CREATE INDEX idx_strategy_threshold_artifacts_run
  ON strategy_threshold_calibration_artifacts(run_id, status);
CREATE INDEX idx_s12_structure_snapshots_date_symbol
  ON s12_structure_snapshots(trade_date DESC, symbol);
CREATE INDEX idx_allocator_ev_snapshots_date
  ON allocator_ev_feature_snapshots(snapshot_date, generated_at DESC);
CREATE INDEX idx_allocator_ev_snapshots_symbol
  ON allocator_ev_feature_snapshots(symbol, snapshot_date DESC);
CREATE INDEX idx_s12_tw_calibration_active
  ON s12_tw_calibration_artifacts(status, superseded_at, market_segment, alpha_bucket, entry_time_bucket, approved_at DESC);
CREATE INDEX idx_s12_replay_trade_outcomes_signal_date
  ON s12_replay_trade_outcomes(signal_date DESC, sample_eligible, symbol);
CREATE UNIQUE INDEX idx_s12_replay_trade_outcomes_signal_setup_v2
  ON s12_replay_trade_outcomes(symbol, signal_date, setup_id)
  WHERE signal_date IS NOT NULL;
CREATE INDEX idx_broker_intents_trade_side
  ON broker_execution_intents(trade_date, side, status);
CREATE INDEX idx_broker_intents_symbol
  ON broker_execution_intents(trade_date, symbol, side);
CREATE INDEX idx_broker_legs_recovery
  ON broker_execution_legs(status, updated_at);
CREATE INDEX idx_broker_events_order_time
  ON broker_execution_events(broker_order_id, event_time);
CREATE INDEX idx_broker_events_client_tag
  ON broker_execution_events(client_tag, event_time);
CREATE INDEX idx_broker_events_unmatched
  ON broker_execution_events(broker_order_id, leg_id);
CREATE INDEX idx_predictions_verification_label
  ON predictions(verification_label_schema_version, prediction_date, model_name)
  WHERE verified_at IS NOT NULL;
CREATE INDEX idx_pipeline_runs_logical_status
  ON pipeline_runs(logical_run_key, status, updated_at DESC);
CREATE INDEX idx_pipeline_runs_fingerprint
  ON pipeline_runs(logical_run_key, input_fingerprint, code_version, config_version);
CREATE INDEX idx_run_artifacts_retention
  ON run_artifacts(status, retain_until, pinned, legal_hold, hard_ref_count);
CREATE INDEX idx_run_artifacts_producer
  ON run_artifacts(producer_run_id, domain, business_date);
CREATE INDEX idx_artifact_d1_scrub_queue_status
  ON artifact_d1_scrub_queue(status, next_attempt_at, created_at);
CREATE INDEX idx_artifact_cleanup_dlq_status
  ON artifact_cleanup_dlq(status, next_attempt_at, created_at);
CREATE INDEX idx_strategy_candidate_contexts_date_symbol
  ON strategy_candidate_contexts(date DESC, symbol);
CREATE INDEX idx_strategy_decision_log_context
  ON strategy_decision_log(context_id);
CREATE INDEX idx_input_snapshots_run ON input_snapshots(run_id, snapshot_type);
CREATE INDEX idx_features_family ON features(feature_version, family);
CREATE INDEX idx_strategies_version ON strategies(strategy_version, strategy_id);
CREATE INDEX idx_analysis_runs_created_at ON analysis_runs(created_at DESC);
CREATE INDEX idx_analysis_runs_status ON analysis_runs(status, updated_at DESC);
CREATE INDEX idx_workflow_steps_run_step ON workflow_steps(run_id, step_id);
CREATE INDEX idx_workflow_checkpoints_status ON workflow_checkpoints(run_id, status);
CREATE INDEX idx_model_calls_run_role ON model_calls(run_id, role);
CREATE INDEX idx_model_calls_date ON model_calls(started_at, source_type);
CREATE INDEX idx_hypotheses_run_mode ON hypotheses(run_id, search_mode);
CREATE INDEX idx_candidates_run_id ON candidates(run_id);
CREATE INDEX idx_audit_issues_run_target ON audit_issues(run_id, target_id);
CREATE INDEX idx_audit_issues_model ON audit_issues(run_id, critic_model);
CREATE INDEX idx_artifacts_run_type ON artifacts(run_id, artifact_type);
CREATE INDEX idx_codex_imports_run_id ON codex_imports(run_id);
CREATE INDEX idx_model_champion_history_asof
  ON model_champion_history(model_name, effective_at, retired_at);
CREATE INDEX idx_allocator_ev_snapshot_runs_date_status
  ON allocator_ev_snapshot_runs(snapshot_date DESC, snapshot_source, status, updated_at DESC);
CREATE INDEX idx_allocator_ev_snapshot_staging_run
  ON allocator_ev_feature_snapshot_staging(run_id, snapshot_date, stock_id);
CREATE INDEX idx_artifact_hard_references_artifact_active
  ON artifact_hard_references(artifact_id, active);
CREATE INDEX idx_artifact_hard_references_owner_active
  ON artifact_hard_references(owner_type, owner_id, active);
CREATE INDEX idx_allocator_ev_daily_lifecycle_state_date
  ON allocator_ev_daily_lifecycle(state, business_date);
CREATE INDEX idx_intraday_minute_bars_symbol_date
  ON intraday_minute_bars(symbol, trade_date, minute_start);
CREATE INDEX idx_active8_oof_predictions_cohort_date
  ON active8_oof_predictions(cohort_id, prediction_date, model_name);
CREATE INDEX idx_allocator_ev_oof_snapshots_cohort_date
  ON allocator_ev_oof_snapshots(cohort_id, snapshot_date);
CREATE INDEX idx_l4_oof_predictions_cohort_date
  ON l4_oof_predictions(cohort_id, prediction_date);
CREATE INDEX idx_active8_oof_fold_artifacts_source
  ON active8_oof_fold_artifacts(source_cohort_id, fold_id, model_name);
CREATE INDEX idx_paper_exit_intents_active_symbol
  ON paper_exit_intents(account_id, symbol, entry_date, state, created_at);
CREATE INDEX idx_paper_exit_intents_retry
  ON paper_exit_intents(state, next_attempt_at, updated_at);
CREATE INDEX idx_active8_oof_materialized_artifacts_checksum
  ON active8_oof_materialized_artifacts(artifact_checksum);
CREATE INDEX idx_model_artifact_registry_model_state
  ON model_artifact_registry(model_name, state, updated_at DESC);
CREATE INDEX idx_model_artifact_registry_candidate_type
  ON model_artifact_registry(candidate_type, state, updated_at DESC);
CREATE INDEX idx_model_artifact_registry_run
  ON model_artifact_registry(training_run_id, source_run_date);
CREATE INDEX idx_selection_reference_v1_date
  ON selection_reference_snapshots_v1(signal_date, hard_gate_passed, strategy_selected);
CREATE INDEX idx_selection_reference_v1_symbol
  ON selection_reference_snapshots_v1(symbol, signal_date DESC);
CREATE INDEX idx_strategy_label_matrix_v4_date
  ON strategy_label_matrix_v4(signal_date, strategy_id, strategy_hit);
CREATE INDEX idx_strategy_label_matrix_v4_symbol
  ON strategy_label_matrix_v4(symbol, signal_date DESC);
CREATE INDEX idx_strategy_label_matrix_runs_v4_date
  ON strategy_label_matrix_runs_v4(signal_date, status, updated_at DESC);
CREATE INDEX idx_canonical_selection_labels_v4_known
  ON canonical_selection_labels_v4(outcome_known_date, signal_date);
CREATE INDEX idx_canonical_selection_labels_v4_symbol
  ON canonical_selection_labels_v4(symbol, signal_date DESC);
CREATE INDEX idx_canonical_selection_label_rejections_v4_date
  ON canonical_selection_label_rejections_v4(signal_date, reason_code);
CREATE INDEX idx_canonical_selection_label_runs_v4_date
  ON canonical_selection_label_runs_v4(as_of_date, status, created_at DESC);
CREATE INDEX idx_strategy_marginal_edge_runs_v4_date
  ON strategy_marginal_edge_runs_v4(as_of_date DESC, status, created_at DESC);
CREATE INDEX idx_strategy_marginal_edge_v4_latest
  ON strategy_marginal_edge_v4(as_of_date DESC, production_eligible, strategy_id);
CREATE INDEX idx_strategy_marginal_edge_dates_v4_date
  ON strategy_marginal_edge_dates_v4(signal_date, run_id);
CREATE INDEX idx_s12_tw_calibration_entry_cohort
  ON s12_tw_calibration_artifacts(
    status, superseded_at, entry_cohort, market_segment, alpha_bucket, entry_time_bucket, approved_at DESC
  );
CREATE INDEX idx_pipeline_stage_runs_status
  ON pipeline_stage_runs(stage, status, business_date DESC);
CREATE INDEX idx_strategy_learning_runs_status
  ON strategy_learning_runs(status, business_date DESC);
CREATE INDEX idx_domain_projection_outbox_pending
  ON domain_projection_outbox(status, available_at, source_domain, target_domain);
CREATE INDEX idx_data_retention_runs_policy_date
  ON data_retention_runs(policy_id, business_date DESC, status);
CREATE INDEX idx_price_horizon_labels_date
  ON price_horizon_labels_v1(price_date, stock_id);
CREATE INDEX idx_price_horizon_labels_outcome
  ON price_horizon_labels_v1(outcome_known_date, price_date);
CREATE INDEX idx_price_horizon_rejections_date
  ON price_horizon_label_rejections_v1(price_date, rejection_reason);
CREATE INDEX idx_strategy_reward_ledger_refresh
  ON strategy_reward_ledger(refresh_run_id, date_end);
CREATE INDEX idx_data_domain_backfill_status
  ON data_domain_backfill_cursors(status, domain, updated_at);
CREATE INDEX idx_data_domain_parity_latest
  ON data_domain_parity_checks(domain, table_name, checked_at DESC);
CREATE INDEX idx_screener_funnel_items_date_id
  ON screener_funnel_items(date, id);
CREATE INDEX idx_active8_oof_retention_action_status
  ON active8_oof_retention_ledger(retention_action, status, hard_reference_count);
CREATE INDEX idx_oof_materialized_history_replacement
  ON active8_oof_materialized_artifact_history(
    cohort_id, artifact_kind, replaced_by_checksum
  );
CREATE INDEX idx_active8_oof_date_eligibility_status
  ON active8_oof_date_eligibility(evidence_scope, eligibility_status, prediction_date, cohort_id);
CREATE INDEX idx_data_retention_cursors_backlog
  ON data_retention_cursors(status, backlog_remaining, policy_id, updated_at);
CREATE INDEX idx_data_retention_run_items_dataset
  ON data_retention_run_items(dataset_id, completed_at DESC, status);
CREATE INDEX idx_s12_structure_batch_runs_date_status
  ON s12_structure_batch_runs(trade_date DESC, status, updated_at DESC);
CREATE INDEX idx_s12_structure_batch_shards_status
  ON s12_structure_batch_shards(status, updated_at, run_id, shard_index);
CREATE INDEX idx_s12_formal_ev_decisions_current
  ON s12_formal_ev_decisions(observation_date DESC, action, source_trade_date DESC, symbol);
CREATE INDEX idx_s12_formal_ev_decisions_symbol
  ON s12_formal_ev_decisions(symbol, observation_date DESC, created_at DESC);
CREATE INDEX idx_sector_flow_pit_lineage
  ON sector_flow(pit_lineage_version, date DESC, updated_at);
CREATE INDEX idx_expected_return_artifact_payloads_owner
  ON expected_return_artifact_payloads(model_name, serving_mode, updated_at DESC);
CREATE INDEX idx_strategy_learning_daily_stats_strategy_date
  ON strategy_learning_daily_stats(strategy_id, strategy_version, date DESC);
CREATE INDEX idx_strategy_learning_daily_stats_date
  ON strategy_learning_daily_stats(date DESC, strategy_id);
CREATE INDEX idx_strategy_decision_log_evaluability ON strategy_decision_log(date DESC, strategy_id, evaluable, matched);
CREATE INDEX idx_strategy_evidence_rebuild_v5_status ON strategy_evidence_rebuild_runs_v5(status, signal_date);
CREATE INDEX idx_strategy_replacement_v5_asof ON strategy_replacement_decisions_v5(as_of_date DESC, status, family_id);
CREATE INDEX idx_strategy_replacement_cutover_guards_v5_run ON strategy_replacement_cutover_guards_v5(run_id, phase);
CREATE VIEW cost_daily AS
  SELECT date, source, provider, model,
         COUNT(*) AS calls,
         SUM(COALESCE(tokens_in, 0))  AS tokens_in_total,
         SUM(COALESCE(tokens_out, 0)) AS tokens_out_total,
         SUM(COALESCE(compute_sec, 0)) AS compute_sec_total,
         ROUND(SUM(est_usd), 4) AS est_usd_total
  FROM cost_events
  GROUP BY date, source, provider, model;
