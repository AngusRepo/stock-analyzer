ALTER TABLE predictions ADD COLUMN prediction_date TEXT;

ALTER TABLE daily_recommendations ADD COLUMN alpha_context TEXT;
ALTER TABLE daily_recommendations ADD COLUMN alpha_allocation TEXT;
ALTER TABLE daily_recommendations ADD COLUMN ml_vote_summary TEXT;
ALTER TABLE daily_recommendations ADD COLUMN score_components TEXT;
ALTER TABLE daily_recommendations ADD COLUMN momentum_score REAL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_predictions_business_date
  ON predictions(prediction_date, stock_id, model_name);
