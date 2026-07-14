-- LOCAL TEST FIXTURE ONLY. Never apply remotely.
CREATE TABLE IF NOT EXISTS strategy_spec_registry (
  strategy_id TEXT NOT NULL, version TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('research','shadow','candidate','active','retired')),
  owner TEXT NOT NULL DEFAULT 'strategy', alpha_bucket TEXT NOT NULL,
  family_id TEXT NOT NULL DEFAULT 'FIXTURE', variant_id TEXT NOT NULL DEFAULT '',
  owner_type TEXT NOT NULL DEFAULT 'strategy', promotion_status TEXT NOT NULL DEFAULT 'production',
  supported_regimes_json TEXT NOT NULL DEFAULT '[]', thesis TEXT NOT NULL,
  thresholds_json TEXT NOT NULL DEFAULT '{}', candidate_policy_json TEXT NOT NULL DEFAULT '{}',
  risk_notes_json TEXT NOT NULL DEFAULT '[]', source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT 'strategy_discovery_local_fixture',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_id, version)
);

CREATE TABLE IF NOT EXISTS strategy_reward_ledger (
  reward_id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, strategy_version TEXT NOT NULL,
  strategy_status TEXT NOT NULL, alpha_bucket TEXT NOT NULL, date_start TEXT, date_end TEXT,
  horizon_days INTEGER NOT NULL DEFAULT 5, samples INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL, avg_return_pct REAL, reward_sum REAL, max_drawdown_pct REAL, coverage REAL,
  market_segment TEXT DEFAULT 'all', regime TEXT DEFAULT 'all', evidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(strategy_id, strategy_version, horizon_days, market_segment, regime)
);

WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 13)
INSERT INTO strategy_spec_registry(strategy_id,version,name,status,alpha_bucket,family_id,supported_regimes_json,thesis,thresholds_json,source_refs_json)
SELECT printf('fixture_s%02d', n), 'fixture-v1', printf('Fixture Strategy %02d', n), 'active',
       CASE WHEN n % 3 = 0 THEN 'defensive' ELSE 'trend' END, printf('FIXTURE_F%02d', n),
       CASE WHEN n = 13 THEN '["bull","sideways","bear","volatile"]' ELSE '["bull","sideways","volatile"]' END,
       printf('Fixture-only hypothesis %02d', n),
       '{"featureRefs":{"primary":{"featureRef":"advance_ratio"}},"dsl":{"fixture":true}}',
       '["LOCAL_FIXTURE_ONLY"]'
FROM sequence;

INSERT OR REPLACE INTO strategy_reward_ledger(reward_id,strategy_id,strategy_version,strategy_status,alpha_bucket,samples,regime,evidence_json)
VALUES
  ('fixture-regime-bull','fixture_s01','fixture-v1','active','trend',31,'bull','{"fixture":true}'),
  ('fixture-regime-sideways','fixture_s01','fixture-v1','active','trend',32,'sideways','{"fixture":true}'),
  ('fixture-regime-volatile','fixture_s01','fixture-v1','active','trend',496,'volatile','{"fixture":true}');
