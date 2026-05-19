import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const controllerDailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const modelPoolRouter = fs.readFileSync('../ml-controller/routers/model_pool.py', 'utf8')

assert(
  adminControlRoutes.includes('const callbackRunDate') &&
    adminControlRoutes.includes('runPostVerifyCallbackChain'),
  'verify-v2 scheduler callback must delegate rolling IC refresh to post-verify chain',
)

assert(
  postMarketChain.includes('runModelIcRollingRefresh(env, ctx.runDate)'),
  'post-verify chain must pass callback run_date into rolling IC refresh',
)

assert(
  adminControlRoutes.includes('const callbackRunId') &&
    adminControlRoutes.includes('run_id: callbackRunId'),
  'scheduler callback must persist callback run_id into canonical scheduler logs',
)

assert(
  controllerDailyWorkflows.includes('runModelIcRollingRefresh(env: Bindings, runDate?: string)') &&
    controllerDailyWorkflows.includes('run_date: runDate || undefined'),
  'rolling IC refresh must send run_date to ml-controller when callback has one',
)

assert(
  modelPoolRouter.includes('run_date: str | None = None') &&
    modelPoolRouter.includes('AND date(prediction_date) <= date(?)') &&
    modelPoolRouter.includes('date(?, ?)'),
  'ml-controller weekly IC endpoint must bound rolling IC to callback run_date for backfills',
)
