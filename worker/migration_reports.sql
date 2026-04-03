-- AI 整合報告持久化（原本只推 Discord，現在同時存 D1）
CREATE TABLE IF NOT EXISTS stock_analysis_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'daily',
  market_summary TEXT,      -- JSON: { risk_level, risk_score, us_context }
  ml_overview TEXT,         -- JSON: { total, buy_count, hold_count, sell_count, buy_avg_conf, sell_avg_conf }
  buy_details TEXT,         -- JSON: [{ symbol, name, confidence, entry, stop, target1, target2, models }]
  sell_alerts TEXT,          -- JSON: [{ symbol, name, confidence, down_count, total_models }]
  recommendations TEXT,     -- JSON: [{ symbol, name, sector, score, confidence, reason }]
  performance TEXT,          -- JSON: { total_value, cumulative_return, daily_return, max_drawdown, sharpe_30d, trade_count }
  theme_flow TEXT,          -- JSON: [{ sector, total_net, quadrant, rs_ratio, rs_momentum }]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, report_type)
);
