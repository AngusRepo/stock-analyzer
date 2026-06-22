import fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const migration = fs.readFileSync('worker/migration_direction_correct_skipped_null_2026_06_22.sql', 'utf8')
const normalized = migration.replace(/\s+/g, ' ').trim()

assert(
  migration.includes('Do not run without explicit Wei approval'),
  'direction_correct repair migration must be explicitly manual',
)
assert(
  migration.includes('runbook_direction_correct_skipped_repair_2026_06_22.md'),
  'direction_correct repair migration must point operators to the approval runbook',
)
assert(
  !/npx\s+wrangler[^\r\n]*--remote\s+--file/i.test(migration),
  'direction_correct repair migration must not recommend direct remote --file execution',
)
assert(
  migration.includes('audit_all_minus_one_by_prediction_state'),
  'direction_correct repair migration must audit all -1 rows by prediction state before updating',
)
assert(
  migration.includes('audit_repair_scope'),
  'direction_correct repair migration must audit skipped/non-directional repair scope before updating',
)
assert(
  normalized.includes('UPDATE predictions SET direction_correct = NULL WHERE direction_correct = -1 AND ( LOWER(COALESCE(actual_direction, \'\')) = \'neutral\' OR LOWER(COALESCE(predicted_direction, \'\')) = \'neutral\' OR LOWER(COALESCE(trade_signal, \'\')) = \'hold\' OR ( predicted_direction IS NULL AND actual_direction IS NULL AND trade_signal IS NULL ) )'),
  'direction_correct repair migration must only null skipped/non-directional -1 rows',
)
assert(
  !/UPDATE\s+predictions\s+SET\s+direction_correct\s*=\s*NULL\s+WHERE\s+direction_correct\s*=\s*-1\s*;/i.test(migration),
  'direction_correct repair migration must not null every -1 row without the neutral guard',
)
assert(
  migration.includes('LOWER(COALESCE(predicted_direction, \'\')) = \'neutral\''),
  'direction_correct repair migration must include predicted neutral rows even when actual_direction is up/down',
)
assert(
  migration.includes('LOWER(COALESCE(trade_signal, \'\')) = \'hold\''),
  'direction_correct repair migration must include HOLD trade_signal rows',
)
assert(
  !/\bDELETE\b/i.test(migration),
  'direction_correct repair migration must not delete historical prediction rows',
)
