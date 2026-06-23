-- RRG full rotation model fields for sector_flow.
-- Apply before deploying a controller that writes rotation_* columns.

ALTER TABLE sector_flow ADD COLUMN rotation_velocity REAL;
ALTER TABLE sector_flow ADD COLUMN rotation_acceleration REAL;
ALTER TABLE sector_flow ADD COLUMN quadrant_age INTEGER;
ALTER TABLE sector_flow ADD COLUMN transition_path TEXT;
ALTER TABLE sector_flow ADD COLUMN rotation_score REAL;
ALTER TABLE sector_flow ADD COLUMN rotation_regime TEXT;
ALTER TABLE sector_flow ADD COLUMN rotation_hysteresis TEXT;
ALTER TABLE sector_flow ADD COLUMN rotation_window INTEGER;
ALTER TABLE sector_flow ADD COLUMN rrg_tail_json TEXT;

CREATE INDEX IF NOT EXISTS idx_sector_flow_rotation_regime
  ON sector_flow(date, classification, rotation_regime);

CREATE INDEX IF NOT EXISTS idx_sector_flow_rotation_score
  ON sector_flow(date, classification, rotation_score DESC);
