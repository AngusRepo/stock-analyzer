import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  SCHEDULER_BATCH_PLAN,
  cronMatchesUtc,
  resolveDueSchedulerBatchJobs,
} from './schedulerBatchPlan'

interface ManifestJob {
  id: string
  schedule: string
  task?: string
  query?: string
  headers?: Record<string, string>
  timeZone?: string
  uriPath?: string
  description?: string
}

const legacy = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  timeZone: string
  jobs: ManifestJob[]
}
const candidate = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.consolidated-candidate.json', 'utf8')) as {
  mutationAllowed: boolean
  generatedFrom: string
  deleteJobIds: string[]
  jobs: ManifestJob[]
}
const shadow = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.consolidated-shadow.json', 'utf8')) as {
  mutationAllowed: boolean
  generatedFrom: string
  deleteJobIds?: string[]
  jobs: ManifestJob[]
}
const legacyById = new Map(legacy.jobs.map((job) => [job.id, job]))
const selectedIds = new Set<string>()

assert.equal(candidate.mutationAllowed, false, 'candidate manifest must fail closed against production mutation')
assert.equal(candidate.generatedFrom, 'infra/gcp-scheduler-jobs.json')
assert.equal(shadow.mutationAllowed, false, 'shadow manifest must also block accidental production mutation')
assert.equal(shadow.generatedFrom, 'infra/gcp-scheduler-jobs.json')
assert.equal(shadow.deleteJobIds, undefined, 'shadow manifest must never delete legacy jobs')
assert.deepEqual(shadow.jobs.slice(0, legacy.jobs.length), legacy.jobs, 'shadow must preserve all legacy jobs unchanged')
const shadowBatchJobs = shadow.jobs.slice(legacy.jobs.length)
assert.equal(shadowBatchJobs.length, SCHEDULER_BATCH_PLAN.batches.length)
assert(shadowBatchJobs.every((job) => job.id.endsWith('-shadow') && job.query === 'dry_run=1'))

for (const batch of SCHEDULER_BATCH_PLAN.batches) {
  const candidateBatch = candidate.jobs.find((job) => job.id === `scheduler-batch-${batch.id}`)
  assert(candidateBatch, `candidate manifest missing batch job ${batch.id}`)
  assert.equal(candidateBatch.schedule, batch.schedule)
  assert.equal(candidateBatch.timeZone, 'UTC')
  assert.equal(candidateBatch.uriPath, `/api/admin/scheduler-batch/${batch.id}`)

  for (const planJob of batch.jobs) {
    assert(!selectedIds.has(planJob.id), `${planJob.id} must belong to exactly one batch`)
    selectedIds.add(planJob.id)
    const legacyJob = legacyById.get(planJob.id)
    assert(legacyJob, `batch source missing from legacy manifest: ${planJob.id}`)
    assert.deepEqual(planJob, legacyJob, `${planJob.id} task/query/header/schedule metadata drifted`)
    assert.equal(planJob.timeZone ?? legacy.timeZone, 'UTC', `${planJob.id} is not safe for UTC batch matching`)
  }
}

assert.deepEqual(
  candidate.deleteJobIds,
  [...selectedIds].sort(),
  'stale deletion allowlist must contain only jobs replaced by a parity-tested batch',
)
const unaffectedLegacy = legacy.jobs.filter((job) => !selectedIds.has(job.id))
const candidateNonBatch = candidate.jobs.filter((job) => !job.id.startsWith('scheduler-batch-'))
assert.deepEqual(candidateNonBatch, unaffectedLegacy, 'candidate must preserve every unaffected job byte-for-byte')
assert.equal(candidate.jobs.length, legacy.jobs.length - selectedIds.size + SCHEDULER_BATCH_PLAN.batches.length)

const expectedCounts = new Map([...selectedIds].map((id) => [id, 0]))
const actualCounts = new Map([...selectedIds].map((id) => [id, 0]))
const start = Date.UTC(2026, 0, 1, 0, 0, 0)
const end = Date.UTC(2027, 0, 1, 0, 0, 0)

for (let timestamp = start; timestamp < end; timestamp += 60_000) {
  const scheduledAt = new Date(timestamp)
  for (const batch of SCHEDULER_BATCH_PLAN.batches) {
    const dueIds = new Set(resolveDueSchedulerBatchJobs(batch.id, scheduledAt).map((job) => job.id))
    for (const job of batch.jobs) {
      const expected = cronMatchesUtc(job.schedule, scheduledAt)
      const actual = dueIds.has(job.id)
      if (expected !== actual) {
        throw new Error(`${job.id} parity mismatch at ${scheduledAt.toISOString()}: expected=${expected} actual=${actual}`)
      }
      if (expected) expectedCounts.set(job.id, (expectedCounts.get(job.id) ?? 0) + 1)
      if (actual) actualCounts.set(job.id, (actualCounts.get(job.id) ?? 0) + 1)
    }
  }
}

for (const id of selectedIds) {
  assert((expectedCounts.get(id) ?? 0) > 0, `${id} has no expected 2026 runs`)
  assert.equal(actualCounts.get(id), expectedCounts.get(id), `${id} annual invocation count drifted`)
}

console.log(`schedulerBatchPlanParity: PASS jobs=${selectedIds.size} candidate_jobs=${candidate.jobs.length} minutes=525600`)
