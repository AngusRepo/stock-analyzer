const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const adminGcp = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const controlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const runLogger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const followup = fs.readFileSync('../ml-controller/routers/retrain_followup.py', 'utf8')

const active8Monthly = manifest.jobs.find((job: any) => job.id === 'active8-oof-monthly')
assert(active8Monthly?.task === 'active8-oof-monthly', 'Active-8 monthly must be the canonical release task')
assert(active8Monthly?.query === 'sync=1', 'Active-8 monthly must preserve observable synchronous admission')
assert(active8Monthly?.timeZone === 'Asia/Taipei', 'Active-8 monthly must use TW wall-clock time')
assert(active8Monthly?.legacyIds?.includes('monthly-retrain'), 'Active-8 monthly must declare the scheduler identity it replaces')
assert(manifest.deleteJobIds?.includes('monthly-retrain'), 'retired monthly-retrain must stay explicitly allowlisted for deletion')
assert(!manifest.jobs.some((job: any) => job.id === 'monthly-retrain' || job.task === 'monthly-retrain'), 'retired monthly-retrain must not remain schedulable')

for (const [label, source] of [
  ['admin task map', adminGcp],
  ['trigger routes', triggerRoutes],
  ['scheduler logger', runLogger],
  ['callback routes', controlRoutes],
] as const) {
  assert(source.includes("'active8-oof-monthly'"), `${label} must expose the Active-8 monthly owner`)
  assert(!source.includes("'monthly-retrain'"), `${label} must not expose the retired monthly owner`)
}

assert(followup.includes('f"active8-oof-{cadence}"'), 'full-fit followup must callback the cadence-specific Active-8 ticket')
assert(!followup.includes('"monthly-retrain"'), 'full-fit followup must never revive the retired monthly scheduler ticket')
