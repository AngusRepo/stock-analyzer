-- Serving-bound T+5 evidence for the exact Fusion artifact used at decision time.
-- This lane is evaluation-only. It cannot train, promote, or mutate champion pointers.

CREATE TABLE IF NOT EXISTS expected_return_serving_forward_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  prediction_date TEXT NOT NULL,
  label_known_date TEXT NOT NULL,
  model_name TEXT NOT NULL CHECK(model_name = 'allocator_ev_fusion'),
  artifact_id TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL CHECK(length(model_fingerprint) = 64),
  model_version TEXT NOT NULL,
  sample_count INTEGER NOT NULL CHECK(sample_count >= 0),
  final_corr REAL,
  l4_corr REAL,
  corr_delta REAL,
  final_spread REAL,
  l4_spread REAL,
  spread_delta REAL,
  quality_decision TEXT NOT NULL CHECK(
    quality_decision IN ('PASS', 'DEGRADED', 'INSUFFICIENT')
  ),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(artifact_id, model_fingerprint, prediction_date)
);

CREATE INDEX IF NOT EXISTS idx_expected_return_serving_forward_identity_date
  ON expected_return_serving_forward_evaluations(
    artifact_id, model_fingerprint, prediction_date DESC
  );

CREATE TABLE IF NOT EXISTS expected_return_forward_guard_state (
  model_name TEXT PRIMARY KEY CHECK(model_name = 'allocator_ev_fusion'),
  artifact_id TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL CHECK(length(model_fingerprint) = 64),
  model_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('monitoring', 'residual_bypass')),
  evaluable_date_count INTEGER NOT NULL DEFAULT 0 CHECK(evaluable_date_count >= 0),
  degraded_streak INTEGER NOT NULL DEFAULT 0 CHECK(degraded_streak >= 0),
  recovery_streak INTEGER NOT NULL DEFAULT 0 CHECK(recovery_streak >= 0),
  last_prediction_date TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expected_return_forward_guard_state_updated
  ON expected_return_forward_guard_state(state, updated_at DESC);
