-- meta-learning-shadow reward hydration (metaLearningShadowDecisions.ts) reads only decisions
-- still waiting for a reward. Without this index it scans meta_shadow_decisions (45,293 rows,
-- 13,858 pending on 2026-11-18) on every post-verify run; with it, it reads the pending rows by
-- business_date. The WHERE clause repeats the query's `counterfactual_reward IS NULL` (SQLite
-- uses a partial index only then); a row leaves the index when hydration writes its reward.
-- The unseekable-pending count of the same function reads the pending rows through it as well
-- (without it: SCAN of all 45,293 rows, 579 ms on 2026-11-18).
-- Size: ~13.9k entries x ~60 B (YYYY-MM-DD + decision_id + rowid) = ~0.9 MB, shrinking as
-- rewards hydrate; new shadow decisions add at most a few hundred entries per business day.
-- Not applied by this change: apply with the normal learning migration flow after review.
-- Rollback: DROP INDEX IF EXISTS idx_meta_shadow_decisions_pending;
CREATE INDEX IF NOT EXISTS idx_meta_shadow_decisions_pending
  ON meta_shadow_decisions(business_date, decision_id)
  WHERE counterfactual_reward IS NULL;
