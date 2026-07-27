import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync('migrations/0085_s12_durable_structure_and_formal_ev.sql', 'utf8')
const taxonomy = fs.readFileSync('src/lib/s12StructureTaxonomy.ts', 'utf8')

for (const table of [
  's12_structure_batch_runs',
  's12_structure_batch_shards',
  's12_formal_ev_decisions',
]) {
  assert(migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} must be durable D1 state`)
}
for (const state of [
  'execution_ready',
  'setup_waiting',
  'risk_blocked',
  'invalidated',
  'unavailable',
]) {
  assert(taxonomy.includes(`'${state}'`), `taxonomy must preserve ${state}`)
  assert(migration.includes(`'${state}'`), `decision ledger must preserve ${state}`)
}

assert(migration.includes("action IN ('potential_buy','hold','abstain')"))
assert(migration.includes('artifact_checksum'))
assert(migration.includes('FOREIGN KEY(run_id) REFERENCES s12_structure_batch_runs(run_id)'))
assert(!migration.includes('global_expected_return'))
assert(!migration.includes('rank_fallback'))
