-- Live account source observations; never reuse Paper cash, positions or NAV.
CREATE TABLE IF NOT EXISTS live_account_observations_v1 (
    account_scope TEXT NOT NULL CHECK(account_scope LIKE 'live:sinopac:%'),
    request_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(account_scope, request_id)
);
CREATE INDEX IF NOT EXISTS idx_live_account_observations_time
ON live_account_observations_v1(account_scope, observed_at);
CREATE TRIGGER IF NOT EXISTS live_account_observations_no_update
BEFORE UPDATE ON live_account_observations_v1 BEGIN SELECT RAISE(ABORT,'live_account_observation_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_account_observations_no_delete
BEFORE DELETE ON live_account_observations_v1 BEGIN SELECT RAISE(ABORT,'live_account_observation_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_account_observations_no_replace
BEFORE INSERT ON live_account_observations_v1
WHEN EXISTS(SELECT 1 FROM live_account_observations_v1
            WHERE account_scope=NEW.account_scope AND request_id=NEW.request_id)
     AND EXISTS(SELECT 1 FROM live_account_observations_v1
                WHERE account_scope=NEW.account_scope AND request_id=NEW.request_id
                AND (sha256!=NEW.sha256 OR payload_json!=NEW.payload_json OR observed_at!=NEW.observed_at))
BEGIN SELECT RAISE(ABORT,'live_account_observation_conflict'); END;
