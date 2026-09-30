import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadStorageCapacityBackfillBaselines } from './storageCapacityTelemetry'
import type { Bindings } from '../types'

async function main() {
  const rows = [{ domain: 'learning', baseline_after: '2026-08-19' }]
  let legacyReads = 0
  const legacy = {
    prepare(sql: string) {
      assert.match(sql, /FROM data_domain_backfill_cursors/)
      return { async all() { legacyReads++; return { results: rows } } }
    },
  } as unknown as D1Database
  const ops = {
    prepare() { throw new Error('capacity_baseline_must_not_use_ops_shadow') },
  } as unknown as D1Database
  for (const MULTI_D1_ACTIVE_DOMAINS of ['', 'ops,learning']) {
    const env = { DB: legacy, OPS_DB: ops, LEARNING_DB: ops, MULTI_D1_ACTIVE_DOMAINS } as unknown as Bindings
    assert.deepEqual((await loadStorageCapacityBackfillBaselines(env)).results, rows)
  }
  assert.equal(legacyReads, 2)

  // The two read APIs and scheduled report must all use the tested owner.
  for (const [file, expected] of [
    ['src/routes/adminReadRoutes.ts', 2],
    ['src/lib/adminTriggerWorkerDomainTasks.ts', 1],
  ] as const) {
    const source = fs.readFileSync(file, 'utf8')
    assert.equal(source.split('loadStorageCapacityBackfillBaselines(c.env)').length - 1, expected)
    assert.doesNotMatch(source, /FROM data_domain_backfill_cursors/)
  }
  console.log('storage capacity baseline owner tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
