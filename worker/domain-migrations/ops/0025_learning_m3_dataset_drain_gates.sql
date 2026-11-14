-- D1-M3: per-dataset hot-window drain gates for learning_lineage_v1.
-- The policy row keeps ONE hot window (120 days) and one archive_delete action, but each
-- Learning dataset is released separately (Wei go per dataset). A dataset whose source is
-- archive-only in code drains only when its row here is status='active' AND
-- action='archive_delete' AND hot_retention_days equals the code spec
-- (worker/src/lib/retentionLearningDrainGates.ts). Anything else stays blocked, fail-closed.
-- This migration only creates draft rows: applying it never archives or deletes anything.
-- predictions is not listed: it already drains through tableSource (M1-d).
CREATE TABLE IF NOT EXISTS data_retention_dataset_gates (
  policy_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  hot_retention_days INTEGER NOT NULL CHECK(hot_retention_days >= 30),
  action TEXT NOT NULL CHECK(action IN ('archive_only', 'archive_delete')),
  status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'retired')),
  version INTEGER NOT NULL DEFAULT 1,
  approved_reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(policy_id, dataset_id),
  FOREIGN KEY(policy_id) REFERENCES data_retention_policies(policy_id)
);

INSERT OR IGNORE INTO data_retention_dataset_gates
  (policy_id, dataset_id, hot_retention_days, action, status, approved_reason)
VALUES
  ('learning_lineage_v1', 'dataset_snapshots', 120, 'archive_only', 'draft',
   'M3 draft: run-report and D1 hot-window manifests only; audit-json, cold-archive and compute snapshots stay hot'),
  ('learning_lineage_v1', 's12_replay_trade_outcomes', 120, 'archive_only', 'draft',
   'M3 draft: writer dormant since 2026-09-14; Worker compact release path exists; code-blocked (s12_python_readers_cold_merge_required) until Python readers get cold merge or retire'),
  ('learning_lineage_v1', 's12_structure_snapshots', 120, 'archive_only', 'draft',
   'M3 draft (NEW-Q14 plan B): live sources s12_intraday_structure / s12_holding_defense never drain'),
  ('learning_lineage_v1', 'strategy_decision_log', 45, 'archive_only', 'draft',
   'M3 draft (Wei 11/4: 45 days): blocked in code until the M2 write contract ships'),
  ('learning_lineage_v1', 'strategy_label_matrix_v4', 45, 'archive_only', 'draft',
   'M3 draft (Wei 11/4: 45 days): blocked in code until the M2 write contract ships');
