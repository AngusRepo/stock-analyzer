-- Keep one stable pending-buy cohort per trade date. Intraday state transitions
-- update that cohort in place instead of creating superseded snapshot runs.
ALTER TABLE pending_buy_runs ADD COLUMN canonical_key TEXT;
ALTER TABLE pending_buy_runs ADD COLUMN state_fingerprint TEXT;
ALTER TABLE pending_buy_runs ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0;

UPDATE pending_buy_runs
   SET status = 'superseded',
       updated_at = datetime('now')
 WHERE status <> 'superseded'
   AND id IN (
     SELECT id
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY trade_date
                  ORDER BY id DESC
                ) AS active_rn
           FROM pending_buy_runs
          WHERE status <> 'superseded'
       )
      WHERE active_rn > 1
   );

UPDATE pending_buy_runs
   SET canonical_key = 'pending-buy:' || trade_date
 WHERE id IN (
   SELECT id
     FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY trade_date
                ORDER BY CASE WHEN status = 'superseded' THEN 1 ELSE 0 END,
                         id DESC
              ) AS rn
         FROM pending_buy_runs
   )
    WHERE rn = 1
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_buy_runs_canonical_key
  ON pending_buy_runs(canonical_key)
  WHERE canonical_key IS NOT NULL;
