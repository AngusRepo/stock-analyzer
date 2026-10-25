-- Both indexes are prefixes of wider ones the planner already uses, and were dropped on prod
-- 2026-10-25 (A12, about -86 MB): predictions date lookups use idx_pred_date_stock_model_generated
-- and the covering idx_pred_date_model_stock; strategy_label_matrix_v4 lookups use _regime_veto
-- and the covering _evaluable. IF EXISTS keeps this a no-op on prod and records the drop.
DROP INDEX IF EXISTS idx_predictions_business_date;
DROP INDEX IF EXISTS idx_strategy_label_matrix_v4_date;
