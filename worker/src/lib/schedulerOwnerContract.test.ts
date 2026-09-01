import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function hasTaskHandler(source: string, task: string): boolean {
  return source.includes(`${task}:`) || source.includes(`'${task}':`) || source.includes(`"${task}":`)
}

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const workerIndex = fs.readFileSync('src/index.ts', 'utf8')
assert(
  /\[triggers\]\s*crons\s*=\s*\[\]/s.test(wrangler),
  'Cloudflare scheduled crons must be explicitly deployed as crons=[] so stale Worker cron triggers are cleared',
)
assert(
  !/crons\s*=\s*\[\s*["']/.test(wrangler),
  'Cloudflare Worker cron list must stay empty; GCP Scheduler is the only scheduler owner',
)
assert(
  workerIndex.includes("ENABLE_CLOUDFLARE_CRON") &&
    workerIndex.includes("GCP Scheduler is the production owner") &&
    workerIndex.includes("return"),
  'Worker scheduled() must fail-closed/no-op unless ENABLE_CLOUDFLARE_CRON=1; stale Cloudflare cron triggers cannot own production',
)

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
assert(manifest.owner === 'gcp-scheduler', 'scheduler manifest must declare gcp-scheduler owner')
assert(Array.isArray(manifest.jobs) && manifest.jobs.length >= 20, 'scheduler manifest should cover daily, intraday, weekly, and monthly jobs')

const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
const cronGcpDomainTasks = fs.readFileSync('src/lib/cronGcpDomainTasks.ts', 'utf8')
const controllerDailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const adminGcpTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const adminTriggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const schedulerStatus = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
assert(
  schedulerStatus.includes("import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'") &&
    schedulerStatus.includes('const JOB_DEF_METADATA: JobDef[]') &&
    schedulerStatus.includes('cron: canonicalCronFor(def)') &&
    schedulerStatus.includes('job.schedule'),
  'OBS scheduler cadence must be projected from the canonical GCP scheduler manifest; local definitions are display metadata only',
)
const schedulerRunLogger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const tradingDayTasks = [
  'intraday-check',
  'intraday-rescore',
  'eod-exit',
  'post-close-price-refresh',
  'daily-snapshot',
  'market-close-refresh',
  'evening-chain',
  'indicator-queue',
  'post-pipeline-chain',
  'post-verify-chain',
  'us-leading',
  'news-analyst',
  'morning-setup',
  'morning-briefing',
  'pre-market-warmup',
  'external-evidence',
]

const workerTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const gcpTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const combinedTasks = `${workerTasks}\n${gcpTasks}`
const ids = new Set<string>()

for (const job of manifest.jobs) {
  assert(job.id && job.schedule && job.task, `scheduler job is incomplete: ${JSON.stringify(job)}`)
  assert(!ids.has(job.id), `duplicate scheduler job id: ${job.id}`)
  ids.add(job.id)
  assert(hasTaskHandler(combinedTasks, job.task), `scheduler task ${job.task} has no admin trigger handler`)
  assert(schedulerPolicy.includes(`${job.task}':`) || schedulerPolicy.includes(`${job.task}:`), `scheduler task ${job.task} must have an explicit calendar policy`)
}

for (const task of tradingDayTasks) {
  const policyPattern = new RegExp(`['"]?${task}['"]?\\s*:\\s*\\{[^}]*kind:\\s*['"]trading_day['"][^}]*holidayGated:\\s*true`, 's')
  assert(policyPattern.test(schedulerPolicy), `${task} must be gated by TW trading calendar / holiday KV`)
}

for (const required of ['market-close-refresh', 'evening-chain', 'intraday-rescore', 'weekly-backtest', 'weekly-cleanup', 'model-ic-full-check', 'optuna-queue', 'pre-market-warmup']) {
  assert(manifest.jobs.some((job: any) => job.task === required || job.id === required), `manifest missing required scheduler job: ${required}`)
}

const intradayWindows = manifest.jobs.filter((job: any) => job.task === 'intraday-check')
assert(intradayWindows.length === 2, 'intraday-check must use exactly two GCP windows for the 13:30 boundary')
assert(
  intradayWindows.some((job: any) => job.schedule === '* 1-4 * * 1-5') &&
    intradayWindows.some((job: any) => job.schedule === '0-30 5 * * 1-5'),
  'intraday-check windows must cover TW 09:00-12:59 and 13:00-13:30 only',
)
assert(!intradayWindows.some((job: any) => job.schedule === '* 1-5 * * 1-5'), 'intraday-check must never trigger at TW 13:31-13:59')

const rescoreSlots = [
  ['rescore-10', '0 2 * * 1-5', 'sync=1&cron=0%202%20%2A%20%2A%201-5'],
  ['rescore-11', '0 3 * * 1-5', 'sync=1&cron=0%203%20%2A%20%2A%201-5'],
  ['rescore-12', '0 4 * * 1-5', 'sync=1&cron=0%204%20%2A%20%2A%201-5'],
  ['rescore-1230', '30 4 * * 1-5', 'sync=1&cron=30%204%20%2A%20%2A%201-5'],
] as const
for (const [id, cron, query] of rescoreSlots) {
  const job = manifest.jobs.find((candidate: any) => candidate.id === id)
  assert(job?.task === 'intraday-rescore' && job?.schedule === cron && job?.query === query, `${id} must carry its exact slot identity into the shared re-score handler`)
  assert(schedulerStatus.includes(`id: '${id}'`) && schedulerRunLogger.includes(`'${id}':`), `${id} must have a first-class OBS definition and display name`)
  assert(workerTasks.includes(`'${cron}': '${id}'`), `${id} must map its cron to a slot-specific runtime log`)
}
assert(workerTasks.includes("status: 'running'") && workerTasks.includes('logSchedulerResult(c.env.KV, slotTask'), 're-score slot must publish running and terminal status for realtime OBS feedback')
assert(!schedulerStatus.includes("{ id: 'intraday-rescore'") && !schedulerStatus.includes("'intraday-rescore', 'morning-setup'"), 'OBS status and heatmap must not retain the collapsed aggregate re-score identity')

const modelIcFullCheck = manifest.jobs.find((job: any) => job.id === 'model-ic-full-check')
assert(modelIcFullCheck?.task === 'model-ic-full-check', 'Friday Model IC must own a separate full-check task identity')
assert(modelIcFullCheck?.legacyIds?.includes('model-ic-tracker'), 'Model IC full-check cutover must explicitly retire the legacy scheduler id')

assert(controllerDailyWorkflows.includes('runModelIcFullCheck') && !controllerDailyWorkflows.includes('runModelIcTrackerChain'), 'full-check workflow function must have a distinct name')
assert(postMarketChain.includes("'model-ic-rolling', () => runModelIcRollingRefresh") && !postMarketChain.includes("'model-ic-tracker', () => runModelIcRollingRefresh"), 'post-verify must log only model-ic-rolling')
assert(adminGcpTasks.includes("'model-ic-full-check': async () => runModelIcFullCheck"), 'admin scheduler trigger must expose only the full-check identity')
assert(adminTriggerRoutes.includes("'model-ic-tracker': 'model-ic-full-check'") && adminTriggerRoutes.includes('resolveSchedulerTaskAlias'), 'legacy trigger URL must canonicalize before policy and logging')
assert(schedulerStatus.includes("id: 'model-ic-rolling'") && schedulerStatus.includes("id: 'model-ic-full-check'") && schedulerStatus.includes("legacyLogIds: ['model-ic-tracker']"), 'OBS status must expose split identities and map old evidence only to full-check')
assert(cronGcpDomainTasks.includes("runWithLog('model-ic-full-check'") && !cronGcpDomainTasks.includes("runWithLog('model-ic-tracker'"), 'cron dispatcher must log only the full-check identity')

const weeklyS12Calibration = manifest.jobs.find((job: any) => job.id === 'weekly-s12-smcvwap-calibration')
assert(weeklyS12Calibration?.task === 's12-smcvwap-calibration', 'weekly S12 calibration must have a first-class GCP Scheduler owner')
assert(weeklyS12Calibration?.schedule === '45 22 * * 6', 'weekly S12 calibration must run Sunday TW 06:45')
assert(weeklyS12Calibration?.query === 'cadence=auto', 'weekly S12 owner must select monthly cadence after the first Saturday without a request-scoped sync timeout')
assert(!manifest.jobs.some((job: any) => job.id === 'monthly-s12-smcvwap-calibration'), 'duplicated monthly S12 scheduler must stay retired')
for (const retired of ['legacy-evidence-migration', 'd1-evidence-scrub', 'cleanup-dlq-replay', 'monthly-s12-smcvwap-calibration', 'monthly-retrain']) {
  assert(manifest.deleteJobIds?.includes(retired), `${retired} must be explicitly allowlisted for deletion`)
}
const externalEvidence = manifest.jobs.find((job: any) => job.id === 'external-evidence')
const weeklyCleanup = manifest.jobs.find((job: any) => job.id === 'weekly-cleanup')
assert(externalEvidence && !externalEvidence.query, 'external evidence must use observable async execution instead of sync request timeout')
assert(weeklyCleanup && !weeklyCleanup.query, 'weekly cleanup must use observable async execution instead of sync request timeout')
assert(schedulerRunLogger.includes("'s12-smcvwap-calibration': 'S12 SMC/VWAP Calibration'"), 'S12 scheduler result must survive canonical log registry filtering')
assert(schedulerRunLogger.includes("'weekly-readiness': 'Weekly Readiness'") && schedulerRunLogger.includes("'monthly-readiness': 'Monthly Readiness'"), 'cadence roots must survive canonical log registry filtering')
assert(schedulerRunLogger.includes("'data-domain-shadow-backfill-next': 'Multi-D1 Sequential Backfill'"), 'backfill coordinator terminal receipt must survive canonical log registry filtering')

for (const replay of [
  ['adaptive-meta-policy-replay', '40 22 * * 6'],
  ['linucb-multiplier-replay', '50 22 * * 6'],
]) {
  const [task, schedule] = replay
  const job = manifest.jobs.find((j: any) => j.id === task)
  assert(job?.task === task, `${task} must be a first-class GCP Scheduler job, not a manual-only task`)
  assert(job?.schedule === schedule, `${task} must run in the Sunday TW weekly evidence window`)
  assert(job?.query === 'sync=1&persist=1', `${task} scheduler must run synchronously and persist evidence`)
  assert(job?.headers?.['X-Confirm-Meta-Learning'] === 'true', `${task} scheduler must pass the explicit meta-learning evidence confirm header`)
}

for (const chained of ['ml-warmup', 'adapt', 'daily-report', 'obsidian-sync', 'regime-compute', 'verify-v2']) {
  assert(
    !manifest.jobs.some((job: any) => job.task === chained || job.id === chained),
    `${chained} must be callback-driven, not a fixed-time Scheduler job`,
  )
}

for (const critical of [
  'evening-chain',
  'market-close-refresh',
  'rescore-10',
  'rescore-11',
  'rescore-12',
  'rescore-1230',
  'alpha-quality',
  'sector-leaders',
  'weekly-backtest',
  'weekly-optuna',
  'adaptive-meta-policy-replay',
  'linucb-multiplier-replay',
  'monthly-optuna',
  'monthly-strategy-mining',
  'active8-oof-monthly',
  'optuna-queue',
  'model-ic-full-check',
]) {
  const job = manifest.jobs.find((j: any) => j.id === critical)
  assert(String(job?.query ?? '').split('&').includes('sync=1'), `${critical} scheduler must run synchronously so GCP sees data-readiness failures`)
}

assert(
  !manifest.jobs.some((job: any) => job.id?.startsWith('source-readiness-probe') || job.task === 'source-readiness-probe'),
  'source-readiness-probe must stay removed from GCP Scheduler',
)

for (const monthly of ['monthly-optuna', 'monthly-strategy-mining', 'active8-oof-monthly']) {
  const job = manifest.jobs.find((j: any) => j.id === monthly)
  assert(job?.schedule?.startsWith('first '), `${monthly} must use Cloud Scheduler groc syntax; cron DOM/DOW is OR and can over-trigger`)
}

const monthlyStrategyMining = manifest.jobs.find((j: any) => j.id === 'monthly-strategy-mining')
assert(monthlyStrategyMining?.task === 'monthly-strategy-mining', 'monthly strategy mining must be a first-class scheduler task')
assert(monthlyStrategyMining?.timeZone === 'Asia/Taipei', 'monthly strategy mining should use TW wall-clock time')
assert(monthlyStrategyMining?.query === 'sync=1&persist=1', 'monthly strategy mining must run synchronously and persist research evidence')

const active8Monthly = manifest.jobs.find((j: any) => j.id === 'active8-oof-monthly')
assert(active8Monthly?.timeZone === 'Asia/Taipei', 'Active-8 monthly release should use TW wall-clock time')
assert(active8Monthly?.task === 'active8-oof-monthly' && active8Monthly?.query === 'sync=1', 'Active-8 monthly release must own the canonical synchronous lifecycle')
assert(active8Monthly?.legacyIds?.includes('monthly-retrain'), 'Active-8 monthly release must explicitly replace the retired universal retrain scheduler')
const monthlyOptuna = manifest.jobs.find((j: any) => j.id === 'monthly-optuna')
assert(monthlyOptuna?.timeZone === 'Asia/Taipei', 'monthly optuna should use TW wall-clock time to match the monthly strategy/retrain sequence')
assert(cronGcpDomainTasks.includes("runWithLog('obsidian-sync'"), 'obsidian scheduler log key must match manifest id obsidian-sync')
assert(!cronGcpDomainTasks.includes("runWithLog('obsidian-daily'"), 'obsidian-daily is a compat trigger alias, not the scheduler log owner')

const syncScript = fs.readFileSync('../scripts/sync_gcp_scheduler.ps1', 'utf8')
assert(syncScript.includes('SCHEDULER_AUTH_TOKEN'), 'scheduler sync must load auth token from env, not source')
assert(syncScript.includes('STOCKVISION_WORKER_BASE_URL'), 'scheduler sync must load worker base URL from env')
assert(syncScript.includes('DRY_RUN_AUTH_TOKEN_PLACEHOLDER'), 'scheduler dry-run must not require production scheduler auth token')
assert(syncScript.includes('https://dry-run-worker-base-url.invalid'), 'scheduler dry-run must not require production worker base URL')
assert(syncScript.includes("'scheduler', 'jobs', 'update', 'http'"), 'scheduler sync must update existing jobs')
assert(syncScript.includes("'scheduler', 'jobs', 'create', 'http'"), 'scheduler sync must create missing jobs')
assert(!syncScript.includes('$exists = $DryRun -or'), 'scheduler dry-run must not pretend every job exists')
assert(syncScript.includes('$exists = $currentIds.Contains([string]$job.id)'), 'scheduler dry-run must classify create/update from remote job state')
assert(syncScript.includes('$query'), 'scheduler sync must append per-job query string')
assert(syncScript.includes('$Job.headers'), 'scheduler sync must support per-job headers for confirm-gated evidence jobs')
assert(syncScript.includes('New-SchedulerHeaderArg'), 'scheduler sync must compose authorization and job-level headers deterministically')
assert(syncScript.includes('$job.timeZone'), 'scheduler sync must support per-job time zones for groc monthly schedules')
assert(syncScript.includes('[switch]$DeleteStale'), 'scheduler sync must support explicit stale GCP job deletion')
assert(syncScript.includes('scheduler jobs delete'), 'scheduler sync must delete stale GCP jobs when DeleteStale is approved')
assert(syncScript.includes('if ($DeleteStale)'), 'scheduler dry-run must show stale job deletion candidates before mutation')
assert(syncScript.includes('$job.legacyIds'), 'scheduler sync must support explicit one-job legacy ID replacement')
assert(syncScript.includes('replace legacy'), 'scheduler sync must surface legacy replacement in dry-run output')
assert(syncScript.includes('scheduler legacy replacement failed'), 'scheduler sync must fail closed if legacy deletion fails')

const cloudflareScheduleSync = fs.readFileSync('../scripts/sync_cloudflare_worker_schedules.ps1', 'utf8')
assert(cloudflareScheduleSync.includes('/workers/scripts/$ScriptName/schedules'), 'Cloudflare Worker schedule sync must use the script schedules API')
assert(cloudflareScheduleSync.includes('[switch]$Clear'), 'Cloudflare Worker schedule sync must require an explicit clear switch')
assert(cloudflareScheduleSync.includes('$DryRun'), 'Cloudflare Worker schedule sync must support dry-run before mutating production schedules')
assert(cloudflareScheduleSync.includes("-Body '[]'"), 'Cloudflare Worker schedule sync must clear stale Worker cron triggers with an empty schedule list')
