import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync(
  'migrations/0110_strategy_evaluability_status_v3.sql',
  'utf8',
)
const executable = migration.replace(/^\s*--.*$/gm, '')

assert.equal(
  (migration.match(/ADD COLUMN evaluability_status/g) ?? []).length,
  2,
  'legacy compatibility migration must add both v3 status columns',
)
assert.doesNotMatch(
  executable,
  /\bUPDATE\b/i,
  'legacy near-capacity migration must not rewrite historical rows in one transaction',
)
assert.doesNotMatch(
  executable,
  /\bCREATE\s+INDEX\b/i,
  'legacy near-capacity migration must not build large compatibility indexes',
)
assert.doesNotMatch(
  executable,
  /\bNOT\s+NULL\b|\bDEFAULT\b|\bCHECK\s*\(/i,
  'legacy near-capacity ADD COLUMN must remain a metadata-only nullable TEXT',
)
assert.match(migration, /bounded, PIT-authoritative strategy evidence/)

console.log('strategy evaluability migration safety tests passed')
