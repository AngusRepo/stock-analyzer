ALTER TABLE strategy_route_calibration_runs_v1 ADD COLUMN absolute_spread REAL;
ALTER TABLE strategy_route_calibration_runs_v1 ADD COLUMN absolute_spread_lcb90 REAL;
ALTER TABLE strategy_route_calibration_runs_v1 ADD COLUMN incumbent_sample_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE strategy_route_calibration_runs_v1 ADD COLUMN paired_sample_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE strategy_route_calibration_runs_v1 ADD COLUMN paired_date_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE strategy_route_calibration_runs_v1 ADD COLUMN challenger_incumbent_delta REAL;
ALTER TABLE strategy_route_calibration_runs_v1 ADD COLUMN challenger_incumbent_delta_lcb90 REAL;
