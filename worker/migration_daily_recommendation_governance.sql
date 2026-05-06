ALTER TABLE daily_recommendations ADD COLUMN market_segment TEXT;
ALTER TABLE daily_recommendations ADD COLUMN recommendation_lane TEXT DEFAULT 'tradable';
ALTER TABLE daily_recommendations ADD COLUMN eligible_for_ml INTEGER DEFAULT 1;
ALTER TABLE daily_recommendations ADD COLUMN eligible_for_pending_buy INTEGER DEFAULT 1;
