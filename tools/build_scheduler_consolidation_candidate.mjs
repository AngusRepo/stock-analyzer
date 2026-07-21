import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'infra', 'gcp-scheduler-jobs.json')
const planPath = path.join(root, 'worker', 'src', 'lib', 'schedulerBatchPlan.json')
const candidatePath = path.join(root, 'infra', 'gcp-scheduler-jobs.consolidated-candidate.json')
const shadowPath = path.join(root, 'infra', 'gcp-scheduler-jobs.consolidated-shadow.json')

const groups = [
  {
    id: 'daily-1900-maintenance',
    schedule: '0 19 * * *',
    sourceJobIds: ['debate-memory-retention', 'orphan-reachability-gc'],
  },
  {
    id: 'weekly-2200-validation',
    schedule: '0 22 * * 6',
    sourceJobIds: ['weekly-backtest', 'alpha-quality'],
  },
  {
    id: 'weekly-2230-research',
    schedule: '30 22 * * 6',
    sourceJobIds: ['weekly-optuna', 'sector-leaders'],
  },
]

const manifest = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const jobsById = new Map(manifest.jobs.map((job) => [job.id, job]))
const selected = new Set()

for (const group of groups) {
  for (const id of group.sourceJobIds) {
    if (!jobsById.has(id)) throw new Error(`Unknown source scheduler job: ${id}`)
    if (selected.has(id)) throw new Error(`Scheduler job assigned to multiple batches: ${id}`)
    selected.add(id)
  }
}

const plan = {
  schemaVersion: 1,
  timeZone: 'UTC',
  batches: groups.map((group) => ({
    id: group.id,
    schedule: group.schedule,
    jobs: group.sourceJobIds.map((id) => jobsById.get(id)),
  })),
}

const batchJobs = groups.map((group) => ({
  id: `scheduler-batch-${group.id}`,
  schedule: group.schedule,
  timeZone: 'UTC',
  uriPath: `/api/admin/scheduler-batch/${group.id}`,
  description: `Consolidated parity-preserving dispatcher for ${group.sourceJobIds.join(', ')}`,
  maxRetryAttempts: 3,
  minBackoff: '30s',
  maxBackoff: '300s',
  maxRetryDuration: '1800s',
}))

const shadow = {
  ...manifest,
  owner: 'gcp-scheduler-consolidated-shadow',
  mutationAllowed: false,
  generatedFrom: 'infra/gcp-scheduler-jobs.json',
  jobs: [
    ...manifest.jobs,
    ...batchJobs.map((job) => ({ ...job, id: `${job.id}-shadow`, query: 'dry_run=1' })),
  ],
}

const candidate = {
  ...manifest,
  owner: 'gcp-scheduler-consolidated-candidate',
  mutationAllowed: false,
  generatedFrom: 'infra/gcp-scheduler-jobs.json',
  deleteJobIds: [...selected].sort(),
  jobs: [...manifest.jobs.filter((job) => !selected.has(job.id)), ...batchJobs],
}

fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`)
fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`)
fs.writeFileSync(shadowPath, `${JSON.stringify(shadow, null, 2)}\n`)

console.log(JSON.stringify({
  source_jobs: manifest.jobs.length,
  consolidated_source_jobs: selected.size,
  batch_jobs: batchJobs.length,
  candidate_jobs: candidate.jobs.length,
  plan: path.relative(root, planPath),
  candidate: path.relative(root, candidatePath),
  shadow: path.relative(root, shadowPath),
  shadow_jobs: shadow.jobs.length,
}, null, 2))
