-- 概念股標籤表：一支股票可屬多個概念（記憶體、CPO、矽光子...）
CREATE TABLE IF NOT EXISTS stock_tags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol    TEXT NOT NULL,
  tag       TEXT NOT NULL,          -- 概念名稱：'記憶體', 'CPO', '矽光子', 'AI Server'...
  source    TEXT DEFAULT 'goodinfo', -- 資料來源：goodinfo / manual / ptt
  weight    REAL DEFAULT 1.0,       -- 關聯強度 0~1（核心成員=1, 邊緣=0.5）
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, tag)
);
CREATE INDEX IF NOT EXISTS idx_stock_tags_symbol ON stock_tags(symbol);
CREATE INDEX IF NOT EXISTS idx_stock_tags_tag ON stock_tags(tag);

-- PTT 題材熱度表：每日記錄各概念被討論的次數
CREATE TABLE IF NOT EXISTS concept_buzz (
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
CREATE INDEX IF NOT EXISTS idx_concept_buzz_date ON concept_buzz(date DESC);
