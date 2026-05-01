const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const logger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')

assert(route.includes('SYNC_REQUIRED_TASKS'), 'admin trigger must define sync-required tasks')
assert(route.includes("'update', 'pipeline'"), 'update/pipeline must not use unobservable background mode')
assert(route.includes('requires sync=1'), 'sync-required tasks must reject async trigger attempts')
assert(route.includes('scheduler:manual:${task}:${runId}'), 'background tasks must write scheduler-scoped run-id logs')
assert(route.includes('run_id: runId'), 'async trigger response must expose run_id')
assert(route.includes('}, 202)'), 'async background trigger should return HTTP 202 Accepted')
assert(logger.includes('console.warn'), 'schedulerRunLogger must not silently swallow KV write failures')
assert(route.includes("../lib/schedulerRunLogger"), 'admin trigger must use schedulerRunLogger naming')
