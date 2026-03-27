-- ─── Paper Trading 模擬交易系統 ────────────────────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_paper_trading.sql

-- ─── 模擬帳戶 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL DEFAULT 'AI 模擬帳戶',
  cash          REAL NOT NULL DEFAULT 1000000.0,   -- 可用現金（台幣）
  initial_cash  REAL NOT NULL DEFAULT 1000000.0,   -- 初始資金（用於計算總報酬）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 委託/成交記錄 ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_orders (
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
CREATE INDEX IF NOT EXISTS idx_paper_orders_account ON paper_orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_orders_symbol  ON paper_orders(symbol, created_at DESC);

-- ─── 持倉快照（每次交易後更新）──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES paper_accounts(id),
  symbol        TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  shares        INTEGER NOT NULL,            -- 目前持股股數
  avg_cost      REAL NOT NULL,               -- 平均成本（含手續費攤入）
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, symbol)
);

-- ─── 每日資產快照（用於畫損益曲線）────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_daily_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES paper_accounts(id),
  date            TEXT NOT NULL,
  cash            REAL NOT NULL,
  positions_value REAL NOT NULL,             -- 持倉市值（用收盤價估算）
  total_value     REAL NOT NULL,             -- 總資產 = cash + positions_value
  pnl             REAL NOT NULL,             -- 累計損益（total_value - initial_cash）
  pnl_pct         REAL NOT NULL,             -- 累計報酬率 %
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, date)
);
CREATE INDEX IF NOT EXISTS idx_paper_snapshots ON paper_daily_snapshots(account_id, date DESC);

-- ─── 建立初始帳戶（幂等，重複執行安全）────────────────────────────────────
INSERT OR IGNORE INTO paper_accounts (id, name, cash, initial_cash)
VALUES (1, 'AI 模擬帳戶', 1000000.0, 1000000.0);
