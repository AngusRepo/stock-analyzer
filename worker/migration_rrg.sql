-- ─── RRG 四象限引擎：sector_flow 新增 RS/Momentum/Quadrant ────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_rrg.sql
--
-- rs_ratio     — 概念相對大盤強度（100 = 與大盤同步，>100 = 強於大盤）
-- rs_momentum  — RS-Ratio 一階差分（>0 = 加速，<0 = 減速）
-- quadrant     — Leading / Weakening / Lagging / Improving

ALTER TABLE sector_flow ADD COLUMN rs_ratio    REAL;
ALTER TABLE sector_flow ADD COLUMN rs_momentum REAL;
ALTER TABLE sector_flow ADD COLUMN quadrant    TEXT;
