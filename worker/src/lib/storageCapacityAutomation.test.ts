import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; schedule: string; task: string; query?: string }>
}

const audit = manifest.jobs.find((job) => job.id === 'audit-json-retention')
assert(audit, 'audit JSON retention scheduler must exist')
assert.equal(audit.schedule, '*/15 17-22 * * *')
assert.match(String(audit.query), /retention_days=30/)
assert.match(String(audit.query), /limit_per_table=500/)
assert.match(String(audit.query), /min_blob_bytes=1024/)
assert.match(String(audit.query), /confirm_archive=ARCHIVE_D1_AUDIT_JSON_TO_R2/)
assert.match(String(audit.query), /durable=1/)

const ops = manifest.jobs.find((job) => job.id === 'data-domain-shadow-backfill-ops')
assert(ops, 'OPS HTTP-isolated shadow backfill scheduler must exist')
assert.equal(ops.schedule, '*/5 17-22 * * *')
assert.match(String(ops.query), /durable=1/)
assert.match(String(ops.query), /direct_step=1/)
assert.match(String(ops.query), /domain=ops/)
assert.match(String(ops.query), /limit=50/)

for (const domain of ['execution', 'paper']) {
  const job = manifest.jobs.find((entry) => entry.id === `data-domain-shadow-backfill-${domain}`)
  assert(job, `${domain} durable shadow backfill scheduler must exist`)
  assert.equal(job.task, 'data-domain-shadow-backfill')
  assert.match(String(job.query), /durable=1/)
  assert.match(String(job.query), new RegExp(`domain=${domain}`))
}

console.log('storage capacity automation contract passed')
