-- Migration: sector_flow 雙層分類
-- 新增 classification 欄位 ('industry' | 'theme')

ALTER TABLE sector_flow ADD COLUMN classification TEXT NOT NULL DEFAULT 'theme';

-- 舊資料來自 D1 chip_data + screener sectors，標記為 theme
-- 新的 FinMind 全市場資料會標記為 industry

-- 建立複合 index（date + classification 常一起查）
CREATE INDEX IF NOT EXISTS idx_sector_flow_date_class ON sector_flow(date, classification);
