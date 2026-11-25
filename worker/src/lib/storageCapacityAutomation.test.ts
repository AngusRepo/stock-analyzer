import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; schedule: string; task: string; query?: string }>
  deleteJobIds: string[]
}

const audit = manifest.jobs.find((job) => job.id === 'audit-json-retention')
assert(audit, 'audit JSON retention scheduler must exist')
assert.equal(audit.schedule, '*/15 17-22 * * *')
assert.match(String(audit.query), /retention_days=30/)
assert.match(String(audit.query), /limit_per_table=500/)
assert.match(String(audit.query), /min_blob_bytes=1024/)
assert.match(String(audit.query), /confirm_archive=ARCHIVE_D1_AUDIT_JSON_TO_R2/)
assert.match(String(audit.query), /durable=1/)

// a65defc5b folded the ops/execution jobs into data-domain-shadow-backfill-next; D9 legacy-DB
// retirement step 4 then retired the coordinator and the paused paper root (manual trigger only).
for (const id of [
  'data-domain-shadow-backfill-ops',
  'data-domain-shadow-backfill-execution',
  'data-domain-shadow-backfill-next',
  'data-domain-shadow-backfill-paper',
]) {
  assert(manifest.deleteJobIds.includes(id), `${id} must be deleted from Cloud Scheduler`)
  assert(!manifest.jobs.some((job) => job.id === id), `${id} must not be re-declared`)
}
assert(
  !manifest.jobs.some((job) => job.task === 'data-domain-shadow-backfill' || job.task === 'data-domain-shadow-backfill-next'),
  'no scheduler root may still drive the shadow backfill writers',
)

console.log('storage capacity automation contract passed')
