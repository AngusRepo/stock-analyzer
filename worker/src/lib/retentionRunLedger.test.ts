import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/lib/retentionRunLedger.ts', 'utf8')
const migration = fs.readFileSync('migrations/0081_retention_cursor_and_run_items.sql', 'utf8')

assert(source.includes('beginRetentionRun'))
assert(source.includes('checkpointRetentionItem'))
assert(source.includes("excluded.status='cycle_complete'"))
assert(source.includes('finishRetentionRun'))
assert(migration.includes('CREATE TABLE IF NOT EXISTS data_retention_cursors'))
assert(migration.includes('CREATE TABLE IF NOT EXISTS data_retention_run_items'))
assert(migration.includes('FOREIGN KEY(run_id) REFERENCES data_retention_runs(run_id)'))

console.log('retention run ledger contract tests passed')
