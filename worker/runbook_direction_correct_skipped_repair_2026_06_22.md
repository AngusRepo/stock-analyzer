# Direction Correct Skipped Repair Runbook

Manual production repair for historical `predictions.direction_correct = -1` skipped / non-directional rows.

Do not execute without explicit Wei approval in the current session.

## Scope

- Production preflight date: `2026-06-22`
- Expected `direction_correct = -1` rows before repair: `26912`
- Expected skipped/non-directional repair scope: `26912`
- Expected remaining `direction_correct = -1` rows after repair: `0`
- No rows are deleted.
- `actual_return_pct` is preserved for IC / RankIC.
- Binary accuracy consumers keep using `direction_correct IN (0,1)`.

Repair predicate:

```sql
direction_correct = -1
AND (
  LOWER(COALESCE(actual_direction, '')) = 'neutral'
  OR LOWER(COALESCE(predicted_direction, '')) = 'neutral'
  OR LOWER(COALESCE(trade_signal, '')) = 'hold'
  OR (
    predicted_direction IS NULL
    AND actual_direction IS NULL
    AND trade_signal IS NULL
  )
)
```

## 1. Pre-Audit

Run exactly this read-only command from `worker/`:

```powershell
npx.cmd wrangler@4 d1 execute stockvision-db --remote --command "SELECT COUNT(*) AS total_minus_one, SUM(CASE WHEN LOWER(COALESCE(actual_direction, '')) = 'neutral' OR LOWER(COALESCE(predicted_direction, '')) = 'neutral' OR LOWER(COALESCE(trade_signal, '')) = 'hold' OR (predicted_direction IS NULL AND actual_direction IS NULL AND trade_signal IS NULL) THEN 1 ELSE 0 END) AS repair_scope, SUM(CASE WHEN NOT (LOWER(COALESCE(actual_direction, '')) = 'neutral' OR LOWER(COALESCE(predicted_direction, '')) = 'neutral' OR LOWER(COALESCE(trade_signal, '')) = 'hold' OR (predicted_direction IS NULL AND actual_direction IS NULL AND trade_signal IS NULL)) THEN 1 ELSE 0 END) AS outside_scope FROM predictions WHERE direction_correct = -1;"
```

Proceed only if:

- `total_minus_one = 26912`
- `repair_scope = 26912`
- `outside_scope = 0`

If counts differ, stop and rerun read-only investigation.

## 2. Approved Repair

Run only after Wei explicitly approves production D1 mutation:

```powershell
npx.cmd wrangler@4 d1 execute stockvision-db --remote --command "UPDATE predictions SET direction_correct = NULL WHERE direction_correct = -1 AND (LOWER(COALESCE(actual_direction, '')) = 'neutral' OR LOWER(COALESCE(predicted_direction, '')) = 'neutral' OR LOWER(COALESCE(trade_signal, '')) = 'hold' OR (predicted_direction IS NULL AND actual_direction IS NULL AND trade_signal IS NULL));"
```

Expected D1 meta:

- `rows_written` may be reported by D1/Wrangler metadata.
- `changed_db = true`.
- No table other than `predictions` is touched.

## 3. Post-Audit

Run immediately after the approved repair:

```powershell
npx.cmd wrangler@4 d1 execute stockvision-db --remote --command "SELECT COUNT(*) AS remaining_minus_one FROM predictions WHERE direction_correct = -1;"
```

Expected:

- `remaining_minus_one = 0`

Then verify binary IC/accuracy scope:

```powershell
npx.cmd wrangler@4 d1 execute stockvision-db --remote --command "SELECT model_name, COUNT(*) AS binary_rows, AVG(direction_correct) AS binary_accuracy FROM predictions WHERE direction_correct IN (0,1) GROUP BY model_name ORDER BY binary_rows DESC LIMIT 20;"
```

## 4. Rollback

Rollback is not expected. Use only if Wei explicitly asks to restore the legacy sentinel.

```powershell
npx.cmd wrangler@4 d1 execute stockvision-db --remote --command "UPDATE predictions SET direction_correct = -1 WHERE direction_correct IS NULL AND (LOWER(COALESCE(actual_direction, '')) = 'neutral' OR LOWER(COALESCE(predicted_direction, '')) = 'neutral' OR LOWER(COALESCE(trade_signal, '')) = 'hold' OR (predicted_direction IS NULL AND actual_direction IS NULL AND trade_signal IS NULL)) AND (prediction_date BETWEEN '2026-04-30' AND '2026-06-18' OR prediction_date IS NULL);"
```

Post-rollback audit:

```powershell
npx.cmd wrangler@4 d1 execute stockvision-db --remote --command "SELECT COUNT(*) AS restored_minus_one FROM predictions WHERE direction_correct = -1;"
```

Expected:

- `restored_minus_one = 26912`
