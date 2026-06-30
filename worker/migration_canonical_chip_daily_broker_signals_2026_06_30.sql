ALTER TABLE canonical_chip_daily ADD COLUMN broker_top15_buy REAL;
ALTER TABLE canonical_chip_daily ADD COLUMN broker_top15_sell REAL;
ALTER TABLE canonical_chip_daily ADD COLUMN broker_buy_sell_ratio REAL;
ALTER TABLE canonical_chip_daily ADD COLUMN broker_balance_index REAL;
