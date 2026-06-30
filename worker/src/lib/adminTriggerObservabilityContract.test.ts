const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const logger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')

assert(route.includes('SYNC_REQUIRED_TASKS'), 'admin trigger must define sync-required tasks')
assert(route.includes("'update', 'pipeline'"), 'update/pipeline must not use unobservable background mode')
assert(route.includes("'post-screener-pipeline'"), 'post-screener repair continuation must require sync=1 so enqueue failures are observable')
assert(route.includes("'strategy-learning'"), 'strategy-learning queue materialization trigger must require sync=1 so enqueue failures are observable')
assert(route.includes("'weekly-optuna'") && route.includes("'monthly-optuna'"), 'weekly/monthly optuna must not hide controller sweep failures in waitUntil')
assert(route.includes("'adaptive-meta-policy-replay', 'linucb-multiplier-replay'"), 'weekly replay evidence jobs must not hide ML-service/data failures in waitUntil')
assert(route.includes('requires sync=1'), 'sync-required tasks must reject async trigger attempts')
assert(route.includes('scheduler:manual:${task}:${runId}'), 'background tasks must write scheduler-scoped run-id logs')
assert(route.includes('run_id: runId'), 'async trigger response must expose run_id')
assert(route.includes('strict: true'), 'async trigger must fail before returning 202 if the initial observable scheduler log cannot be persisted')
assert(route.includes('}, 202)'), 'async background trigger should return HTTP 202 Accepted')
assert(logger.includes('console.warn'), 'schedulerRunLogger must not silently swallow KV write failures')
assert(logger.includes('if (result.strict) throw error'), 'schedulerRunLogger must support strict observable writes for manual async triggers')
assert(route.includes("../lib/schedulerRunLogger"), 'admin trigger must use schedulerRunLogger naming')
