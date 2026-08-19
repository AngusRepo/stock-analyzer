import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  domainBackfillParityBatchLimit,
} from './dataDomainShadowBackfill'

assert.equal(domainBackfillParityBatchLimit(500), 4000)

const root = process.cwd()
const source = fs.readFileSync(`${root}/src/lib/dataDomainShadowBackfill.ts`, 'utf8')
const drain = fs.readFileSync(`${root}/src/lib/dataDomainShadowBackfillDrain.ts`, 'utf8')
const scheduler = fs.readFileSync(`${root}/../infra/gcp-scheduler-jobs.json`, 'utf8')

assert(source.includes('beforeAncestorWrite'))
assert(source.includes('foreign_key_ancestor_sync:'))
assert(source.includes('domain_shadow_foreign_key_cycle'))
assert(source.includes('domain_shadow_foreign_key_owner_mismatch'))
assert(source.includes("PRAGMA foreign_key_list"))
assert(source.includes('domain_shadow_foreign_key_source_missing'))
assert(source.includes('reconcileTargetOnlyPage('))
assert(source.includes("'delete_reconciliation'"))
assert(source.includes("status: 'shadow_delete_reconciliation_progress'"))
assert(source.includes("status: 'shadow_delete_reconciliation_deferred'"))
assert(source.includes("error_code='source_growth_recopy_required'"))
assert(source.includes('data-domain-full-recopy-reset-v1'))
assert(source.includes('domain_shadow_full_checksum_recopy_required:'))
assert(source.includes('domain_full_recopy_reset_cutover_blocked:'))
assert(drain.includes("status === 'shadow_delete_reconciliation_deferred'"))
assert(scheduler.includes('"id": "data-domain-shadow-backfill-ops"'))
assert(scheduler.includes('target-only delete reconciliation'))

const rawCountMismatch = source.indexOf(
  'if (sourceRows !== targetRows) throw new Error(`domain_shadow_count_mismatch',
)
const deleteReconciliation = source.indexOf('reconcileTargetOnlyPage(')
assert(deleteReconciliation >= 0)
assert(rawCountMismatch > deleteReconciliation)

console.log('data domain shadow reconciliation tests passed')
