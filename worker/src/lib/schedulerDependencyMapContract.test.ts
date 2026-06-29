import * as fs from 'node:fs'
import {
  SCHEDULER_DEPENDENCY_MAP,
  schedulerConsolidationCandidates,
  type SchedulerDependencySpec,
} from './schedulerDependencyMap'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; task: string }>
}
const workerTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const gcpTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const cronWorker = fs.readFileSync('src/lib/cronWorkerDomainTasks.ts', 'utf8')
const cronGcp = fs.readFileSync('src/lib/cronGcpDomainTasks.ts', 'utf8')
const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
const schedulerStatus = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
const morningBriefing = fs.readFileSync('src/lib/morningBriefing.ts', 'utf8')
const sectorCorrelation = fs.readFileSync('src/lib/sectorCorrelation.ts', 'utf8')
const combinedHandlers = `${workerTasks}\n${gcpTasks}\n${cronWorker}\n${cronGcp}`

function hasHandler(task: string): boolean {
  return combinedHandlers.includes(`'${task}'`) ||
    combinedHandlers.includes(`"${task}"`) ||
    combinedHandlers.includes(`${task}:`)
}

function hasExplicitPolicy(task: string): boolean {
  return schedulerPolicy.includes(`'${task}':`) || schedulerPolicy.includes(`${task}:`)
}

function assertSafeConsolidationSpec(spec: SchedulerDependencySpec): void {
  assert(spec.currentFunction.length >= 20, `${spec.task} must describe its current function before consolidation`)
  assert(spec.recommendation.length >= 20, `${spec.task} must have an operator-facing recommendation`)
  assert(hasExplicitPolicy(spec.task), `${spec.task} must keep an explicit scheduler policy while it is being consolidated`)

  if (spec.consolidationClass !== 'keep_scheduler') {
    assert(spec.replacementOwner, `${spec.task} cannot be consolidated without a replacement owner`)
    assert(spec.requiredBeforeDisable.length > 0, `${spec.task} must list preconditions before disabling`)
  }

  if (spec.operatorRisk === 'high') {
    assert(
      spec.consolidationClass !== 'disable_candidate',
      `${spec.task} is high-risk and cannot be marked as a direct disable candidate`,
    )
  }
}

for (const spec of Object.values(SCHEDULER_DEPENDENCY_MAP)) {
  assertSafeConsolidationSpec(spec)
  assert(hasHandler(spec.task), `${spec.task} must keep a scheduled/manual handler during consolidation`)
}

for (const required of [
  'daily-snapshot',
  'pre-market-warmup',
  'model-ic-tracker',
  'weekly-audit',
  'alpha-quality',
  'sector-leaders',
  'news-analyst',
  'us-leading',
  'weekly-cleanup',
  'optuna-queue',
]) {
  assert(SCHEDULER_DEPENDENCY_MAP[required], `dependency map missing reviewed scheduler: ${required}`)
}

for (const task of ['daily-snapshot', 'pre-market-warmup', 'model-ic-tracker']) {
  const spec = SCHEDULER_DEPENDENCY_MAP[task]
  assert(spec.operatorRisk === 'high', `${task} must remain high-risk because it affects execution/account/model evidence`)
  assert(spec.consolidationClass === 'merge_into_chain', `${task} must be merged into a chain, not deleted`)
}

{
  const optunaQueue = SCHEDULER_DEPENDENCY_MAP['optuna-queue']
  assert(optunaQueue.consolidationClass === 'disable_candidate', 'optuna-queue is the only direct disable candidate today')
  assert(optunaQueue.operatorRisk === 'low', 'optuna-queue can only be direct-disable if normal search moved to sweep/manual drain')
  assert(optunaQueue.requiredBeforeDisable.some((item) => item.includes('weekly/monthly')), 'optuna-queue replacement must mention weekly/monthly sweep')
}

for (const task of ['news-analyst', 'us-leading', 'sector-leaders']) {
  const spec = SCHEDULER_DEPENDENCY_MAP[task]
  assert(spec.consolidationClass === 'downstream_evidence', `${task} should become evidence input, not a production owner`)
  assert(spec.downstream.length > 0, `${task} must declare consumers before being moved under another chain`)
}

assert(
  morningBriefing.includes('fetchAndStoreUSLeading') &&
    morningBriefing.includes('us-leading:refreshed'),
  'morning briefing must be able to backfill us-leading before us-leading scheduler can be consolidated',
)
assert(
  morningBriefing.includes('readCurrentNewsReport') &&
    morningBriefing.includes('runDailyNewsAnalysis') &&
    morningBriefing.includes('news-analyst:refreshed'),
  'morning briefing must consume/backfill news analyst evidence before news-analyst scheduler can be consolidated',
)
assert(
  morningBriefing.includes('Evidence path / 資料閉環'),
  'morning briefing must expose evidence path so fallback/backfill is observable',
)

assert(
  sectorCorrelation.includes('ensureSectorLeadersForScreener') &&
    sectorCorrelation.includes('computeSectorLeaders(db)') &&
    sectorCorrelation.includes('if (!leaderRows.length)'),
  'sector leader evidence must be backfilled from the screener path before sector-leaders scheduler can be consolidated',
)

const manifestTaskSet = new Set(manifest.jobs.map((job) => job.task))
assert(
  schedulerStatus.includes("id: 'market-close-refresh'") &&
    schedulerStatus.includes("id: 'source-readiness-probe'") &&
    schedulerStatus.indexOf("id: 'market-close-refresh'") < schedulerStatus.indexOf("id: 'source-readiness-probe'") &&
    schedulerStatus.indexOf("id: 'source-readiness-probe'") < schedulerStatus.indexOf("id: 'evening-chain'"),
  'scheduler status must show real readiness-gated jobs before the 22:00 fallback evening-chain',
)
assert(
  !schedulerStatus.includes('market-data-update') &&
    !schedulerStatus.includes('source-readiness-retry'),
  'scheduler status must not expose UI-only or legacy readiness pseudo jobs',
)
for (const spec of Object.values(SCHEDULER_DEPENDENCY_MAP)) {
  if (spec.owner === 'gcp_scheduler') {
    assert(
      manifestTaskSet.has(spec.task),
      `${spec.task} must stay in GCP manifest until the replacement chain/manual owner has been deployed and verified`,
    )
  } else {
    assert(
      schedulerStatus.includes(`id: '${spec.task}'`),
      `${spec.task} chain/manual owner must stay visible in scheduler status until deployment is verified`,
    )
  }
}

const activeConsolidations = schedulerConsolidationCandidates()
  .filter((spec) => spec.consolidationClass !== 'keep_scheduler')
assert(activeConsolidations.length >= 8, 'scheduler consolidation map should explicitly track the reviewed cleanup surface')
