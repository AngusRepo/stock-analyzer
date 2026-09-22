-- A receipt is inserted in the SAME source D1 transaction as exact row deletion.
CREATE TABLE IF NOT EXISTS market_retention_releases_v1 (
 artifact_id TEXT PRIMARY KEY,
 checksum TEXT NOT NULL,
 dataset_id TEXT NOT NULL,
 row_count INTEGER NOT NULL CHECK(row_count > 0 AND row_count <= 250),
 released_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS market_retention_releases_v1_immutable_update
 BEFORE UPDATE ON market_retention_releases_v1 BEGIN SELECT RAISE(ABORT,'retention_release_immutable'); END;
CREATE TRIGGER IF NOT EXISTS market_retention_releases_v1_immutable_delete
 BEFORE DELETE ON market_retention_releases_v1 BEGIN SELECT RAISE(ABORT,'retention_release_immutable'); END;
CREATE TRIGGER IF NOT EXISTS market_retention_releases_v1_immutable_replace
 BEFORE INSERT ON market_retention_releases_v1 WHEN EXISTS(SELECT 1 FROM market_retention_releases_v1 WHERE artifact_id=NEW.artifact_id)
 BEGIN SELECT RAISE(ABORT,'retention_release_immutable'); END;
