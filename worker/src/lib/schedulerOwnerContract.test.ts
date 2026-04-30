const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function hasTaskHandler(source: string, task: string): boolean {
  return source.includes(`${task}:`) || source.includes(`'${task}':`) || source.includes(`"${task}":`)
}

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
assert(!wrangler.includes('[triggers]'), 'Cloudflare scheduled crons must stay disabled; GCP Scheduler is the only scheduler owner')

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
assert(manifest.owner === 'gcp-scheduler', 'scheduler manifest must declare gcp-scheduler owner')
assert(Array.isArray(manifest.jobs) && manifest.jobs.length >= 20, 'scheduler manifest should cover daily, intraday, weekly, and monthly jobs')

const workerTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const gcpTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const combinedTasks = `${workerTasks}\n${gcpTasks}`
const ids = new Set<string>()

for (const job of manifest.jobs) {
  assert(job.id && job.schedule && job.task, `scheduler job is incomplete: ${JSON.stringify(job)}`)
  assert(!ids.has(job.id), `duplicate scheduler job id: ${job.id}`)
  ids.add(job.id)
  assert(hasTaskHandler(combinedTasks, job.task), `scheduler task ${job.task} has no admin trigger handler`)
}

for (const required of ['update', 'ml-warmup', 'intraday-rescore', 'weekly-backtest', 'weekly-cleanup', 'model-ic-tracker', 'optuna-queue', 'pre-market-warmup']) {
  assert(manifest.jobs.some((job: any) => job.task === required || job.id === required), `manifest missing required scheduler job: ${required}`)
}

for (const critical of ['update', 'pipeline']) {
  const job = manifest.jobs.find((j: any) => j.id === critical)
  assert(job?.query === 'sync=1', `${critical} scheduler must run synchronously so GCP sees data-readiness failures`)
}

const syncScript = fs.readFileSync('../scripts/sync_gcp_scheduler.ps1', 'utf8')
assert(syncScript.includes('SCHEDULER_AUTH_TOKEN'), 'scheduler sync must load auth token from env, not source')
assert(syncScript.includes('STOCKVISION_WORKER_BASE_URL'), 'scheduler sync must load worker base URL from env')
assert(syncScript.includes("'scheduler', 'jobs', 'update', 'http'"), 'scheduler sync must update existing jobs')
assert(syncScript.includes("'scheduler', 'jobs', 'create', 'http'"), 'scheduler sync must create missing jobs')
assert(syncScript.includes('$query'), 'scheduler sync must append per-job query string')
