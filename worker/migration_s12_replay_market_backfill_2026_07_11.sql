-- Restore canonical exchange metadata for historical S12 replay outcomes.
-- Unresolved symbols remain unchanged and are excluded from scoped calibration.

UPDATE s12_replay_trade_outcomes
SET market = (
  SELECT stocks.market
  FROM stocks
  WHERE stocks.symbol = s12_replay_trade_outcomes.symbol
  LIMIT 1
)
WHERE (market IS NULL OR market = '' OR market = 'UNKNOWN')
  AND EXISTS (
    SELECT 1
    FROM stocks
    WHERE stocks.symbol = s12_replay_trade_outcomes.symbol
      AND stocks.market IN ('TWSE', 'OTC', 'US')
  );
