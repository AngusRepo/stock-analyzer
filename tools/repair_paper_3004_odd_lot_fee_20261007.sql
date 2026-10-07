-- Execute all statements as ONE D1 batch after fresh preflight.
-- Correction of an unsettled Paper liability, not a rebate or cash deposit.
INSERT INTO paper_execution_events
  (account_id,trade_date,symbol,side,event_type,status,reason,detail_json,order_id,source)
SELECT 1,'2026-10-07','3004','buy','accounting_correction','prepared',
  'sinopac_odd_lot_fee_order_96_v1',
  json_object('schema','paper_fee_correction_v1','old_commission',20,'new_commission',5,
    'old_total_cost',3802,'new_total_cost',3787,'correction_amount',15,
    'settled_cash_change',0,'available_cash_change',15,'monthly_rebate',0,
    'original_execution_event_id',170752,'policy','sinopac_gross_odd_lot_minimum_1_floor'),
  96,'sinopac_fee_policy_correction_v1'
WHERE EXISTS (SELECT 1 FROM paper_orders WHERE id=96 AND account_id=1 AND symbol='3004'
  AND side='buy' AND shares=31 AND price=122 AND commission=20 AND tax=0 AND total_cost=3802
  AND created_at='2026-10-07 04:10:21' AND json_valid(note))
  AND (SELECT COUNT(*) FROM paper_orders WHERE account_id=1 AND symbol='3004'
    AND created_at>='2026-10-07')=1
  AND EXISTS (SELECT 1 FROM paper_positions WHERE id=2 AND account_id=1 AND symbol='3004'
    AND shares=31 AND entry_price=122 AND entry_date='2026-10-07'
    AND abs(avg_cost*31-3802)<0.000001)
  AND EXISTS (SELECT 1 FROM paper_settlements WHERE id=84 AND account_id=1 AND order_id=96
    AND symbol='3004' AND side='buy' AND amount=3802 AND trade_date='2026-10-07'
    AND settlement_date='2026-10-12' AND settled=0 AND settled_at IS NULL)
  AND (SELECT COUNT(*) FROM paper_settlements WHERE account_id=1 AND order_id=96)=1
  AND EXISTS (SELECT 1 FROM paper_accounts WHERE id=1)
  AND NOT EXISTS (SELECT 1 FROM paper_execution_events WHERE account_id=1 AND order_id=96
    AND reason='sinopac_odd_lot_fee_order_96_v1');

UPDATE paper_positions SET avg_cost=3787.0/31,updated_at=datetime('now')
WHERE id=2 AND account_id=1 AND symbol='3004' AND EXISTS (
  SELECT 1 FROM paper_execution_events WHERE account_id=1 AND order_id=96
    AND reason='sinopac_odd_lot_fee_order_96_v1' AND status='prepared');

UPDATE paper_settlements SET amount=3787
WHERE id=84 AND account_id=1 AND order_id=96 AND EXISTS (
  SELECT 1 FROM paper_execution_events WHERE account_id=1 AND order_id=96
    AND reason='sinopac_odd_lot_fee_order_96_v1' AND status='prepared');

UPDATE paper_orders SET commission=5,total_cost=3787,
  note=json_set(note,'$.fee_correction',json_object('schema','paper_fee_correction_v1',
    'old_commission',20,'new_commission',5,'correction_amount',15,'monthly_rebate',0,
    'event_id',(SELECT id FROM paper_execution_events WHERE account_id=1 AND order_id=96
      AND reason='sinopac_odd_lot_fee_order_96_v1' AND status='prepared')))
WHERE id=96 AND account_id=1 AND EXISTS (
  SELECT 1 FROM paper_execution_events WHERE account_id=1 AND order_id=96
    AND reason='sinopac_odd_lot_fee_order_96_v1' AND status='prepared');

UPDATE paper_execution_events SET status='completed'
WHERE account_id=1 AND order_id=96 AND reason='sinopac_odd_lot_fee_order_96_v1'
  AND status='prepared';
