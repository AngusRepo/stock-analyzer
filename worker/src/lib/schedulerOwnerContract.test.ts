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
const tradingDayTasks = [
  'intraday-check',
  'intraday-rescore',
  'eod-exit',
  'post-close-price-refresh',
  'daily-snapshot',
  'market-close-refresh',
  'source-readiness-probe',
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

for (const required of ['market-close-refresh', 'source-readiness-probe', 'evening-chain', 'intraday-rescore', 'weekly-backtest', 'weekly-cleanup', 'model-ic-tracker', 'optuna-queue', 'pre-market-warmup']) {
  assert(manifest.jobs.some((job: any) => job.task === required || job.id === required), `manifest missing required scheduler job: ${required}`)
}

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
  'source-readiness-probe-1830-1850',
  'source-readiness-probe-1910-2150',
  'rescore-10',
  'rescore-11',
  'rescore-12',
  'rescore-1230',
  'alpha-quality',
  'sector-leaders',
  'weekly-cleanup',
  'weekly-backtest',
  'weekly-optuna',
  'adaptive-meta-policy-replay',
  'linucb-multiplier-replay',
  'monthly-optuna',
  'monthly-strategy-mining',
  'monthly-retrain',
  'optuna-queue',
  'external-evidence',
]) {
  const job = manifest.jobs.find((j: any) => j.id === critical)
  assert(String(job?.query ?? '').split('&').includes('sync=1'), `${critical} scheduler must run synchronously so GCP sees data-readiness failures`)
}

for (const monthly of ['monthly-optuna', 'monthly-strategy-mining', 'monthly-retrain']) {
  const job = manifest.jobs.find((j: any) => j.id === monthly)
  assert(job?.schedule?.startsWith('first '), `${monthly} must use Cloud Scheduler groc syntax; cron DOM/DOW is OR and can over-trigger`)
}

const monthlyStrategyMining = manifest.jobs.find((j: any) => j.id === 'monthly-strategy-mining')
assert(monthlyStrategyMining?.task === 'monthly-strategy-mining', 'monthly strategy mining must be a first-class scheduler task')
assert(monthlyStrategyMining?.timeZone === 'Asia/Taipei', 'monthly strategy mining should use TW wall-clock time')
assert(monthlyStrategyMining?.query === 'sync=1&persist=1', 'monthly strategy mining must run synchronously and persist research evidence')

const monthlyRetrain = manifest.jobs.find((j: any) => j.id === 'monthly-retrain')
assert(monthlyRetrain?.timeZone === 'Asia/Taipei', 'monthly retrain should use TW wall-clock time instead of UTC offset gymnastics')
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

const cloudflareScheduleSync = fs.readFileSync('../scripts/sync_cloudflare_worker_schedules.ps1', 'utf8')
assert(cloudflareScheduleSync.includes('/workers/scripts/$ScriptName/schedules'), 'Cloudflare Worker schedule sync must use the script schedules API')
assert(cloudflareScheduleSync.includes('[switch]$Clear'), 'Cloudflare Worker schedule sync must require an explicit clear switch')
assert(cloudflareScheduleSync.includes('$DryRun'), 'Cloudflare Worker schedule sync must support dry-run before mutating production schedules')
assert(cloudflareScheduleSync.includes("-Body '[]'"), 'Cloudflare Worker schedule sync must clear stale Worker cron triggers with an empty schedule list')
