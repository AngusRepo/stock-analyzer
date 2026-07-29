import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; task: string; schedule: string; query?: string }>
}
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const controllerResearchWorkflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const adminTriggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const adminTriggerTaskMap = fs.readFileSync('src/lib/adminTriggerTaskMap.ts', 'utf8')
const adminTriggerWorkerDomainTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const schedulerStatus = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')
const observabilityPage = fs.readFileSync('../frontend/src/pages/ObservabilityPage.tsx', 'utf8')
const finlabContract = JSON.parse(fs.readFileSync('../data/finlab_source_contract.json', 'utf8')) as {
  lanes: Record<string, { required_fields?: string[] }>
}

assert(
  manifest.jobs.some((job) => job.id === 'evening-chain' && job.task === 'evening-chain' && job.schedule === '0 13 * * 1-5' && job.query === 'sync=1'),
  'evening-chain must be the TW 21:00 primary GCP Scheduler root',
)
assert(
  !manifest.jobs.some((job) => job.id.startsWith('source-readiness-probe') || job.task === 'source-readiness-probe'),
  'source-readiness-probe must not be present in the GCP Scheduler manifest',
)

for (const source of [
  updateOrchestrator,
  controllerResearchWorkflows,
  adminControlRoutes,
  adminTriggerRoutes,
  adminTriggerTaskMap,
  adminTriggerWorkerDomainTasks,
  schedulerStatus,
  schedulerPolicy,
  types,
  observabilityPage,
]) {
  assert(!source.includes('source-readiness-probe'), 'source-readiness-probe must not remain in Worker runtime paths')
  assert(!source.includes('source_readiness_recheck'), 'source_readiness_recheck queue path must be retired')
  assert(!source.includes('readiness_probe'), 'readiness_probe callback mode must be retired')
  assert(!source.includes('runSourceReadinessProbe'), 'runSourceReadinessProbe must not be exposed or callable')
}

assert(
  updateOrchestrator.includes("'source_readiness_retry'") &&
    types.includes("| 'source_readiness_retry'"),
  'evening-chain must retain its own delayed source-readiness retry path',
)
assert(
  updateOrchestrator.includes("callbackMode: 'evening_chain'") &&
    controllerResearchWorkflows.includes("callbackMode?: 'evening_chain'") &&
    adminControlRoutes.includes('continueEveningChain'),
  'FinLab daily source refresh must continue through evening-chain callbacks only',
)

assert(
  finlabContract.lanes.regime_context?.required_fields?.includes('official_tpex_index'),
  'TWOII readiness must have an explicit official_tpex_index source-contract owner',
)
assert(
  updateOrchestrator.includes('const readiness = await checkEveningChainSourceReadiness(env, triggerTime)') &&
    updateOrchestrator.includes('if (hasFinLabRefreshableMissing(readiness))') &&
    updateOrchestrator.includes('await runDailyUpdate(env, true, triggerTime)'),
  'source readiness retry must redispatch scoped FinLab canonical lanes before legacy supplemental bulk fetch',
)
console.log('sourceReadinessProbeAutomationContract.test.ts passed')
