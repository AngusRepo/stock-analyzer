import fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const runbook = fs.readFileSync('worker/runbook_direction_correct_skipped_repair_2026_06_22.md', 'utf8')

assert(
  runbook.includes('Do not execute without explicit Wei approval'),
  'direction_correct repair runbook must require explicit Wei approval',
)
assert(
  runbook.includes('total_minus_one = 26912') &&
    runbook.includes('repair_scope = 26912') &&
    runbook.includes('outside_scope = 0'),
  'direction_correct repair runbook must gate execution on audited production counts',
)
assert(
  runbook.includes('UPDATE predictions SET direction_correct = NULL WHERE direction_correct = -1'),
  'direction_correct repair runbook must contain the approved repair command',
)
assert(
  runbook.includes('SELECT COUNT(*) AS remaining_minus_one FROM predictions WHERE direction_correct = -1'),
  'direction_correct repair runbook must contain post-repair audit',
)
assert(
  runbook.includes('UPDATE predictions SET direction_correct = -1 WHERE direction_correct IS NULL'),
  'direction_correct repair runbook must document rollback command',
)
assert(
  !/--remote\s+--file/i.test(runbook),
  'direction_correct repair runbook must use explicit --command calls, not remote --file import mode',
)
