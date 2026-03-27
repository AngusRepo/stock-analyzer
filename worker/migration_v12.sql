-- ─── StockVision Schema Migration v12 ────────────────────────────────────────
-- 安全可重複執行：每個語句只在欄位/表不存在時才執行

-- 新增 users.approval_status 欄位
ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(approval_status IN ('approved','pending','rejected'));

-- 將現有用戶全部設為 approved（遷移前已存在的用戶視為已核准）
UPDATE users SET approval_status = 'approved' WHERE approval_status = 'pending';

-- ⚠ Bootstrap admin：首次部署後請手動執行以下指令提升自己為 admin
-- wrangler d1 execute stockvision-db --remote \
--   --command "UPDATE users SET role='admin', approval_status='approved' WHERE email='你的email'"

-- 新增每日推薦表
CREATE TABLE IF NOT EXISTS daily_recommendations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  stock_id     INTEGER REFERENCES stocks(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  name         TEXT NOT NULL,
  sector       TEXT,
  rank         INTEGER NOT NULL,
  score        REAL NOT NULL,
  signal       TEXT,
  confidence   REAL,
  chip_score   REAL,
  tech_score   REAL,
  ml_score     REAL,
  reason       TEXT NOT NULL,
  watch_points TEXT,
  has_buy_signal INTEGER DEFAULT 0,
  current_price REAL,
  foreign_net_5d REAL,
  trust_net_5d   REAL,
  rsi14         REAL,
  macd_hist     REAL,
  sector_rank   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, stock_id)
);
CREATE INDEX IF NOT EXISTS idx_rec_date ON daily_recommendations(date DESC);

-- 新增族群資金流向表
CREATE TABLE IF NOT EXISTS sector_flow (
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
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, sector)
);
CREATE INDEX IF NOT EXISTS idx_sector_flow_date ON sector_flow(date DESC, total_net DESC);
