-- L-2 (D1 capacity): running totals of archived Learning `predictions` per (stock_id, model_name).
-- retention-hot-window-drain writes them in the same D1 batch as the exact delete of each archived
-- chunk (retentionPredictionColdStats.ts), so they cover exactly the deleted rows. verify_service
-- period='all' (model_accuracy, trade_performance) adds them to the hot aggregates; without them
-- 'all' would either shrink to the 120-day hot window or download every R2 chunk each night.
-- Size: one row per (stock, model) that ever had an archived row, ~45 numbers each: about
-- 2,000 stocks x 10 models x ~0.5 KB = ~10 MB, fixed (it does not grow with the archive).
-- Reads: one paged primary-key pass per verify run (SEARCH by PK range, no SCAN of predictions).
-- Must be applied before the first confirmed predictions drain: without the table the drain batch
-- fails and rolls back (nothing deleted). Not applied by this change: use the normal learning
-- migration flow after review.
-- Rollback (only while no predictions chunk has been released): DROP TABLE IF EXISTS prediction_cold_stats_v1;
CREATE TABLE IF NOT EXISTS prediction_cold_stats_v1 (
  stock_id INTEGER NOT NULL,
  model_name TEXT NOT NULL,
  d_total INTEGER NOT NULL DEFAULT 0,
  d_correct INTEGER NOT NULL DEFAULT 0,
  d_err_sum REAL,
  d_err_n INTEGER NOT NULL DEFAULT 0,
  d_low_total INTEGER NOT NULL DEFAULT 0,
  d_low_correct INTEGER NOT NULL DEFAULT 0,
  d_high_total INTEGER NOT NULL DEFAULT 0,
  d_high_correct INTEGER NOT NULL DEFAULT 0,
  d_win_sum REAL,
  d_win_n INTEGER NOT NULL DEFAULT 0,
  d_loss_sum REAL,
  d_loss_n INTEGER NOT NULL DEFAULT 0,
  d_pnl_sum REAL,
  d_pnl_n INTEGER NOT NULL DEFAULT 0,
  d_r_sum REAL,
  d_r_n INTEGER NOT NULL DEFAULT 0,
  d_gross_profit REAL,
  d_gross_loss REAL,
  d_hit_target INTEGER NOT NULL DEFAULT 0,
  d_hit_stop INTEGER NOT NULL DEFAULT 0,
  t_total INTEGER NOT NULL DEFAULT 0,
  t_wins INTEGER NOT NULL DEFAULT 0,
  t_losses INTEGER NOT NULL DEFAULT 0,
  t_pnl_sum REAL,
  t_win_sum REAL,
  t_loss_sum REAL,
  t_max REAL,
  t_min REAL,
  t_gross_profit REAL,
  t_gross_loss REAL,
  t_r_sum REAL,
  t_r_n INTEGER NOT NULL DEFAULT 0,
  t_hit_t1 INTEGER NOT NULL DEFAULT 0,
  t_hit_t2 INTEGER NOT NULL DEFAULT 0,
  t_hit_stop INTEGER NOT NULL DEFAULT 0,
  t_expired INTEGER NOT NULL DEFAULT 0,
  t_mfe_sum REAL,
  t_mfe_n INTEGER NOT NULL DEFAULT 0,
  t_mae_sum REAL,
  t_mae_n INTEGER NOT NULL DEFAULT 0,
  label_v4_violations INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0 CHECK(archived_rows >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, model_name)
);
