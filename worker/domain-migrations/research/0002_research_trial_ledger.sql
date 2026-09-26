-- Append-only research provenance; no historical result gains promotion authority.

CREATE TABLE IF NOT EXISTS research_trial_sources_v1 (
 receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id)=64),
 run_key TEXT NOT NULL, logical_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_trial_sources_v1_run ON research_trial_sources_v1(run_key,logical_id);
CREATE TRIGGER IF NOT EXISTS research_trial_sources_v1_no_update BEFORE UPDATE ON research_trial_sources_v1
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_trial_sources_v1_no_delete BEFORE DELETE ON research_trial_sources_v1
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_trial_sources_v1_no_replace BEFORE INSERT ON research_trial_sources_v1
 WHEN EXISTS (SELECT 1 FROM research_trial_sources_v1 WHERE receipt_id=NEW.receipt_id)
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;


CREATE TABLE IF NOT EXISTS research_trial_runs_v1 (
 receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id)=64),
 run_key TEXT NOT NULL, logical_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_trial_runs_v1_run ON research_trial_runs_v1(run_key,logical_id);
CREATE TRIGGER IF NOT EXISTS research_trial_runs_v1_no_update BEFORE UPDATE ON research_trial_runs_v1
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_trial_runs_v1_no_delete BEFORE DELETE ON research_trial_runs_v1
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_trial_runs_v1_no_replace BEFORE INSERT ON research_trial_runs_v1
 WHEN EXISTS (SELECT 1 FROM research_trial_runs_v1 WHERE receipt_id=NEW.receipt_id)
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;


CREATE TABLE IF NOT EXISTS research_trial_observations_v1 (
 receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id)=64),
 run_key TEXT NOT NULL, logical_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_trial_observations_v1_run ON research_trial_observations_v1(run_key,logical_id);
CREATE TRIGGER IF NOT EXISTS research_trial_observations_v1_no_update BEFORE UPDATE ON research_trial_observations_v1
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_trial_observations_v1_no_delete BEFORE DELETE ON research_trial_observations_v1
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_trial_observations_v1_no_replace BEFORE INSERT ON research_trial_observations_v1
 WHEN EXISTS (SELECT 1 FROM research_trial_observations_v1 WHERE receipt_id=NEW.receipt_id)
 BEGIN SELECT RAISE(ABORT,'research_ledger_immutable'); END;
