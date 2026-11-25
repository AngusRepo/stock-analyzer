import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  evaluateLegacyRetirementImpact,
  LEGACY_DATA_RETIREMENT_POLICY,
  type LegacyRetirementImpactEvidence,
} from './legacyDataRetirementSafety'

const base: LegacyRetirementImpactEvidence = {
  table: 'predictions',
  kind: 'mechanically_invalid_row',
  candidate_rows: 10,
  table_specific_invalidity_contract: true,
  canonical_rejection_receipt: true,
  target_parity_passed: true,
  archive_checksum_verified: true,
  runtime_reader_references: 0,
  foreign_key_references: 0,
  hard_lineage_references: 0,
  explicit_wei_approval: true,
}

assert.equal(evaluateLegacyRetirementImpact(base).row_delete_allowed, true)
assert.equal(evaluateLegacyRetirementImpact({ ...base, runtime_reader_references: 1 }).row_delete_allowed, false)
assert.equal(evaluateLegacyRetirementImpact({ ...base, foreign_key_references: 1 }).row_delete_allowed, false)
assert.equal(evaluateLegacyRetirementImpact({ ...base, hard_lineage_references: 1 }).row_delete_allowed, false)
const superseded = evaluateLegacyRetirementImpact({ ...base, kind: 'superseded_version_row' })
assert.equal(superseded.row_delete_allowed, false)
assert.equal(superseded.action, 'archive_payload_keep_scalar_lineage')
assert.equal(LEGACY_DATA_RETIREMENT_POLICY.automatic_delete, false)
assert.equal(LEGACY_DATA_RETIREMENT_POLICY.broad_date_or_version_delete_allowed, false)

const source = readFileSync('src/lib/legacyDataRetirementSafety.ts', 'utf8')
assert.doesNotMatch(source, /DELETE\s+FROM|db\.prepare|\.batch\(/i)
const scheduler = JSON.parse(readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
// D9 step 4 retired the scheduled root; no scheduler job may carry a retirement confirmation.
assert(scheduler.deleteJobIds.includes('legacy-hot-data-retirement'))
assert(!scheduler.jobs.some((job: { id?: string; task?: string }) => job.id === 'legacy-hot-data-retirement' || job.task === 'legacy-hot-data-retirement'))
assert(!scheduler.jobs.some((job: { query?: string }) => /confirm_retirement=/.test(String(job.query ?? ''))))

console.log('legacy data retirement safety tests passed')
