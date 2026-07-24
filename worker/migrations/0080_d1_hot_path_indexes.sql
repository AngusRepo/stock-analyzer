-- Keyset access for bounded screener evidence retention.
CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_date_id
  ON screener_funnel_items(date, id);
