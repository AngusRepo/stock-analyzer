-- Derived state is published only with the exact source DELETE + immutable release receipt.
CREATE INDEX IF NOT EXISTS idx_learning_release_dataset_v1
 ON learning_retention_releases_v1(dataset_id,artifact_id,checksum,row_count);
CREATE TABLE IF NOT EXISTS s12_replay_cold_batches_v1 (
 artifact_id TEXT PRIMARY KEY REFERENCES learning_retention_releases_v1(artifact_id) DEFERRABLE INITIALLY DEFERRED,
 source_checksum TEXT NOT NULL,
 row_count INTEGER NOT NULL CHECK(row_count > 0 AND row_count <= 250),
 rows_checksum TEXT NOT NULL,
 projection_artifact_id TEXT NOT NULL UNIQUE,
 projection_key TEXT NOT NULL,
 projection_checksum TEXT NOT NULL,
 projection_bytes INTEGER NOT NULL CHECK(projection_bytes > 0 AND projection_bytes <= 7340032),
 cost_bps REAL NOT NULL CHECK(cost_bps >= 0)
);
CREATE TABLE IF NOT EXISTS s12_replay_cold_identities_v1 (
 id INTEGER PRIMARY KEY,
 artifact_id TEXT NOT NULL REFERENCES s12_replay_cold_batches_v1(artifact_id),
 symbol TEXT NOT NULL,
 signal_date TEXT,
 trade_date TEXT NOT NULL,
 setup_id TEXT,
 row_checksum TEXT NOT NULL,
 producer_checksum TEXT NOT NULL,
 sample_eligible INTEGER NOT NULL,
 source TEXT NOT NULL,
 status_json TEXT NOT NULL CHECK(json_valid(status_json)),
 UNIQUE(symbol,trade_date,setup_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_s12_cold_signal_setup_v1
 ON s12_replay_cold_identities_v1(symbol,signal_date,setup_id) WHERE signal_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_s12_cold_identity_artifact_v1 ON s12_replay_cold_identities_v1(artifact_id);
CREATE INDEX IF NOT EXISTS idx_s12_cold_signal_symbol_v1 ON s12_replay_cold_identities_v1(signal_date,symbol);
CREATE TABLE IF NOT EXISTS s12_replay_cold_rewards_v1 (
 artifact_id TEXT NOT NULL REFERENCES s12_replay_cold_batches_v1(artifact_id),
 signal_date TEXT NOT NULL,
 outcome_known_date TEXT NOT NULL,
 engine_signature TEXT NOT NULL,
 samples INTEGER NOT NULL CHECK(samples > 0),
 hits INTEGER NOT NULL CHECK(hits >= 0 AND hits <= samples),
 reward_sum REAL NOT NULL,
 PRIMARY KEY(artifact_id,signal_date,outcome_known_date,engine_signature)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_s12_cold_reward_engine_date_v1
 ON s12_replay_cold_rewards_v1(engine_signature,signal_date,outcome_known_date);
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_batches_v1_immutable_update BEFORE UPDATE ON s12_replay_cold_batches_v1
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_batches_v1_immutable_delete BEFORE DELETE ON s12_replay_cold_batches_v1
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_batches_v1_immutable_replace BEFORE INSERT ON s12_replay_cold_batches_v1
 WHEN EXISTS(SELECT 1 FROM s12_replay_cold_batches_v1 WHERE artifact_id=NEW.artifact_id)
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_identities_v1_immutable_update BEFORE UPDATE ON s12_replay_cold_identities_v1
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_identities_v1_immutable_delete BEFORE DELETE ON s12_replay_cold_identities_v1
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_identities_v1_immutable_replace BEFORE INSERT ON s12_replay_cold_identities_v1
 WHEN EXISTS(SELECT 1 FROM s12_replay_cold_identities_v1 WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_rewards_v1_immutable_update BEFORE UPDATE ON s12_replay_cold_rewards_v1
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_rewards_v1_immutable_delete BEFORE DELETE ON s12_replay_cold_rewards_v1
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_rewards_v1_immutable_replace BEFORE INSERT ON s12_replay_cold_rewards_v1
 WHEN EXISTS(SELECT 1 FROM s12_replay_cold_rewards_v1 WHERE artifact_id=NEW.artifact_id AND signal_date=NEW.signal_date AND outcome_known_date=NEW.outcome_known_date AND engine_signature=NEW.engine_signature)
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_immutable'); END;
-- Per-row identity, not a day-level freeze; NULL setup keys retain SQLite UNIQUE semantics.
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_key_insert_v1 BEFORE INSERT ON s12_replay_trade_outcomes
 WHEN EXISTS(SELECT 1 FROM s12_replay_cold_identities_v1 c
  WHERE c.id=NEW.id OR (c.symbol=NEW.symbol AND c.setup_id=NEW.setup_id
   AND (c.trade_date=NEW.trade_date OR c.signal_date=NEW.signal_date)))
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_archived_key'); END;
-- Per-row identity, not a day-level freeze; NULL setup keys retain SQLite UNIQUE semantics.
CREATE TRIGGER IF NOT EXISTS s12_replay_cold_key_update_v1 BEFORE UPDATE ON s12_replay_trade_outcomes
 WHEN EXISTS(SELECT 1 FROM s12_replay_cold_identities_v1 c
  WHERE c.id=NEW.id OR (c.symbol=NEW.symbol AND c.setup_id=NEW.setup_id
   AND (c.trade_date=NEW.trade_date OR c.signal_date=NEW.signal_date)))
 BEGIN SELECT RAISE(ABORT,'retention_s12_replay_archived_key'); END;
