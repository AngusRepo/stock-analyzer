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
// The per-domain ops job was folded into the sequential coordinator; delete reconciliation
// stays inside backfillDataDomainTableShadow, which every coordinator step runs.
const schedulerConfig = JSON.parse(scheduler) as { jobs: Array<{ id: string; description?: string }>; deleteJobIds: string[] }
const coordinator = schedulerConfig.jobs.find((job) => job.id === 'data-domain-shadow-backfill-next')
assert(coordinator)
const backfillOrder = drain.match(/const DOMAIN_BACKFILL_ORDER: DataDomain\[\] = \[([^\]]*)\]/)?.[1] ?? ''
assert(backfillOrder.includes("'ops'"), 'the sequential coordinator must still backfill the ops domain')
assert(schedulerConfig.deleteJobIds.includes('data-domain-shadow-backfill-ops'))
assert(!schedulerConfig.jobs.some((job) => job.id === 'data-domain-shadow-backfill-ops'))

const rawCountMismatch = source.indexOf(
  'if (sourceRows !== targetRows) throw new Error(`domain_shadow_count_mismatch',
)
const deleteReconciliation = source.indexOf('reconcileTargetOnlyPage(')
assert(deleteReconciliation >= 0)
assert(rawCountMismatch > deleteReconciliation)

console.log('data domain shadow reconciliation tests passed')
