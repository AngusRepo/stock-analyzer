-- Phase 2: 大盤綜合指標強化 — 新增 ADL / 融資維持率 / 多空排列
ALTER TABLE market_risk ADD COLUMN adl_value REAL;
ALTER TABLE market_risk ADD COLUMN adl_trend TEXT;
ALTER TABLE market_risk ADD COLUMN margin_maintenance_rate REAL;
ALTER TABLE market_risk ADD COLUMN bull_alignment_count INTEGER;
ALTER TABLE market_risk ADD COLUMN bull_alignment_pct REAL;
