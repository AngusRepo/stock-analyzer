const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const jobs = manifest.jobs as Array<{ id: string; task: string; schedule: string; query?: string }>

assert(
  jobs.some((job) => job.id === 'evening-chain' && job.task === 'evening-chain' && job.query === 'sync=1'),
  'GCP Scheduler must trigger one evening-chain root job for the post-market DAG',
)

for (const removed of ['update', 'screener', 'pipeline']) {
  assert(
    !jobs.some((job) => job.id === removed),
    `${removed} must not remain as an independent fixed-time Scheduler job`,
  )
}

const workerTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
assert(workerTasks.includes("'evening-chain'"), 'admin trigger map must expose evening-chain')

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert(updateOrchestrator.includes('indicator-queue'), 'indicator queue must have scheduler-visible run state')
assert(updateOrchestrator.includes('runMarketScreener'), 'evening chain must run screener after indicator readiness')
assert(
  updateOrchestrator.indexOf('runMarketScreener') < updateOrchestrator.indexOf('runMLAndRiskV2'),
  'evening chain must run screener before pipeline/ML',
)

const mlPipelineTrigger = fs.readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')
assert(
  mlPipelineTrigger.includes('assertEveningPipelineReady'),
  'pipeline trigger must require evening-chain readiness before calling ml-controller',
)
