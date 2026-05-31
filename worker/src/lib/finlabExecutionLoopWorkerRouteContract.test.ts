import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const indexSource = readFileSync('src/index.ts', 'utf8')
const routeSource = readFileSync('src/routes/finlabExecutionLoopRoutes.ts', 'utf8')

assert(
  indexSource.includes('finlabExecutionLoopRoutes'),
  'Worker must mount the FinLab execution loop internal route',
)
assert(
  routeSource.includes("post('/api/internal/execution/intraday-check'"),
  'FinLab execution loop must use a dedicated internal intraday-check endpoint',
)
assert(
  routeSource.includes('requireServiceToken'),
  'internal execution loop endpoint must require the service token',
)
assert(
  routeSource.includes('runIntradayCheck'),
  'internal execution loop endpoint must call the existing paper intraday execution path',
)
assert(
  routeSource.includes('logSchedulerResult') &&
    routeSource.includes("logSchedulerResult(c.env.KV, 'intraday-check'"),
  'internal execution loop endpoint must preserve intraday-check scheduler logging',
)
assert(
  !routeSource.includes('ratelimit:admin'),
  '10-second execution loop must not reuse the admin trigger hourly rate limit',
)
assert(
  routeSource.includes("paper_order_mode: 'worker_intraday_check'"),
  'internal route response must identify the Worker paper-order simulation path',
)
assert(
  routeSource.includes('live_submit_enabled: false') &&
    routeSource.includes('can_submit_real_order: false'),
  'internal route must explicitly report real-order submission disabled',
)
