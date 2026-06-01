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
assert(!manifest.jobs.some((job: any) => job.id === 'finlab-v4-backfill'), 'finlab-v4-backfill must not be a fixed-time Scheduler job')
assert(
  Array.isArray(manifest.deprecatedJobs) &&
    manifest.deprecatedJobs.some((job: any) => job.id === 'finlab-v4-backfill'),
  'deprecated direct FinLab backfill scheduler must stay declared so sync can fail on stale live jobs',
)
const intradayCheckJobs = manifest.jobs.filter((job: any) => job.task === 'intraday-check')
assert(intradayCheckJobs.length === 2, 'intraday-check must be split into two GCP jobs so it stops at TW 13:30')
assert(
  manifest.deprecatedJobs.some((job: any) => job.id === 'intraday-check'),
  'legacy single intraday-check Scheduler job must stay declared as deprecated until deleted from live GCP',
)
const intradaySchedules = new Set(intradayCheckJobs.map((job: any) => job.schedule))
assert(intradaySchedules.has('* 1-4 * * 1-5'), 'intraday-check should cover TW 09:00-12:59')
assert(intradaySchedules.has('0-30 5 * * 1-5'), 'intraday-check should cover TW 13:00-13:30')
assert(!intradaySchedules.has('* 1-5 * * 1-5'), 'intraday-check must not run until TW 13:59')
for (const intradayCheckJob of intradayCheckJobs) {
  assert(intradayCheckJob?.baseUrlEnv === 'ML_CONTROLLER_URL', 'intraday-check scheduler should target ML Controller for real 10s execution loop')
  assert(intradayCheckJob?.path === '/finlab/execution/production-simulated-loop', 'intraday-check scheduler should call production-simulated execution loop route')
  assert(intradayCheckJob?.authHeaderName === 'X-Controller-Token', 'ML Controller scheduler job should use controller token header')
  assert(intradayCheckJob?.authTokenEnv === 'ML_CONTROLLER_SECRET', 'ML Controller scheduler job should load token from env')
  assert(intradayCheckJob?.body?.dry_run === false, 'intraday-check scheduler should run real loop, not plan-only dry-run')
  assert(intradayCheckJob?.body?.duration_seconds === 50, 'intraday-check scheduler should run bounded 50s loops inside a 60s cadence')
  assert(intradayCheckJob?.body?.poll_seconds === 10, 'intraday-check scheduler should poll every 10 seconds')
}

const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
const cronGcpDomainTasks = fs.readFileSync('src/lib/cronGcpDomainTasks.ts', 'utf8')
const tradingDayTasks = [
  'intraday-check',
  'intraday-rescore',
  'eod-exit',
  'daily-snapshot',
  'evening-chain',
  'indicator-queue',
  'post-pipeline-chain',
  'post-verify-chain',
  'us-leading',
  'news-analyst',
  'morning-setup',
  'morning-briefing',
  'pre-market-warmup',
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

for (const required of ['evening-chain', 'intraday-rescore', 'weekly-backtest', 'weekly-cleanup', 'model-ic-tracker', 'optuna-queue', 'pre-market-warmup']) {
  assert(manifest.jobs.some((job: any) => job.task === required || job.id === required), `manifest missing required scheduler job: ${required}`)
}

for (const chained of ['ml-warmup', 'adapt', 'daily-report', 'obsidian-sync', 'regime-compute', 'verify-v2']) {
  assert(
    !manifest.jobs.some((job: any) => job.task === chained || job.id === chained),
    `${chained} must be callback-driven, not a fixed-time Scheduler job`,
  )
}

for (const critical of [
  'evening-chain',
  'rescore-10',
  'rescore-11',
  'rescore-12',
  'rescore-1230',
  'alpha-quality',
  'sector-leaders',
  'weekly-cleanup',
  'weekly-backtest',
  'weekly-optuna',
  'monthly-optuna',
  'monthly-retrain',
  'optuna-queue',
]) {
  const job = manifest.jobs.find((j: any) => j.id === critical)
  assert(job?.query === 'sync=1', `${critical} scheduler must run synchronously so GCP sees data-readiness failures`)
}

for (const monthly of ['monthly-optuna', 'monthly-retrain']) {
  const job = manifest.jobs.find((j: any) => j.id === monthly)
  assert(job?.schedule?.startsWith('first '), `${monthly} must use Cloud Scheduler groc syntax; cron DOM/DOW is OR and can over-trigger`)
}

const monthlyRetrain = manifest.jobs.find((j: any) => j.id === 'monthly-retrain')
assert(monthlyRetrain?.timeZone === 'Asia/Taipei', 'monthly retrain should use TW wall-clock time instead of UTC offset gymnastics')
assert(cronGcpDomainTasks.includes("runWithLog('obsidian-sync'"), 'obsidian scheduler log key must match manifest id obsidian-sync')
assert(!cronGcpDomainTasks.includes("runWithLog('obsidian-daily'"), 'obsidian-daily is a compat trigger alias, not the scheduler log owner')

const syncScript = fs.readFileSync('../scripts/sync_gcp_scheduler.ps1', 'utf8')
assert(syncScript.includes('SCHEDULER_AUTH_TOKEN'), 'scheduler sync must load auth token from env, not source')
assert(syncScript.includes('STOCKVISION_WORKER_BASE_URL'), 'scheduler sync must load worker base URL from env')
assert(syncScript.includes('$job.baseUrlEnv'), 'scheduler sync must support per-job base URL env for controller jobs')
assert(syncScript.includes('$job.path'), 'scheduler sync must support per-job direct paths')
assert(syncScript.includes('$job.authHeaderName'), 'scheduler sync must support per-job auth header names')
assert(syncScript.includes('$job.authTokenEnv'), 'scheduler sync must support per-job auth token env names')
assert(syncScript.includes('--message-body'), 'scheduler sync must support JSON request bodies')
assert(syncScript.includes('$nativeBodyJson') && syncScript.includes(".Replace('\"', '\\\"')"), 'scheduler sync must escape JSON quotes for Windows PowerShell native args')
assert(syncScript.includes('Content-Type=application/json'), 'scheduler sync must set JSON content type for body jobs')
assert(syncScript.includes("'scheduler', 'jobs', 'update', 'http'"), 'scheduler sync must update existing jobs')
assert(syncScript.includes("'scheduler', 'jobs', 'create', 'http'"), 'scheduler sync must create missing jobs')
assert(syncScript.includes('$query'), 'scheduler sync must append per-job query string')
assert(syncScript.includes('$job.timeZone'), 'scheduler sync must support per-job time zones for groc monthly schedules')
assert(syncScript.includes('[switch]$DeleteStale'), 'scheduler sync must support explicit stale GCP job deletion')
assert(syncScript.includes('$deprecatedHits'), 'scheduler sync must detect manifest-deprecated live jobs')
assert(syncScript.includes('deprecated live Scheduler job(s) still exist'), 'scheduler sync must fail fast when deprecated live jobs remain')
assert(syncScript.includes('Re-run with -DeleteStale only after production approval'), 'scheduler sync must require production approval before deleting deprecated jobs')
assert(syncScript.includes('scheduler jobs delete'), 'scheduler sync must delete stale GCP jobs when DeleteStale is approved')

const cloudflareScheduleSync = fs.readFileSync('../scripts/sync_cloudflare_worker_schedules.ps1', 'utf8')
assert(cloudflareScheduleSync.includes('/workers/scripts/$ScriptName/schedules'), 'Cloudflare Worker schedule sync must use the script schedules API')
assert(cloudflareScheduleSync.includes('[switch]$Clear'), 'Cloudflare Worker schedule sync must require an explicit clear switch')
assert(cloudflareScheduleSync.includes('$DryRun'), 'Cloudflare Worker schedule sync must support dry-run before mutating production schedules')
assert(cloudflareScheduleSync.includes("-Body '[]'"), 'Cloudflare Worker schedule sync must clear stale Worker cron triggers with an empty schedule list')
