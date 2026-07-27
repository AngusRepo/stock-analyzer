import assert from 'node:assert/strict'
import fs from 'node:fs'

const lease = fs.readFileSync('src/lib/intradayExecutionLease.ts', 'utf8')
const paper = fs.readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const watcher = fs.readFileSync('src/lib/s12IntradaySetupWatch.ts', 'utf8')
const intradayData = fs.readFileSync('src/lib/paperIntradayData.ts', 'utf8')
const callback = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')

assert(lease.includes("INSERT INTO scheduler_locks"))
assert(lease.includes("scheduler_locks.expires_at <= excluded.created_at"))
assert(lease.includes("UPDATE scheduler_locks"))
assert(lease.includes("DELETE FROM scheduler_locks"))
assert(paper.includes("acquireIntradayExecutionLease"))
assert(paper.includes("refreshIntradayExecutionLease"))
assert(paper.includes("releaseIntradayExecutionLease"))
assert(watcher.includes("/s12-structure/batch/run"))
assert(watcher.includes("response.status === 409"))
assert(watcher.includes("runBounded(nearSeeds, options.concurrency ?? 4"))
assert(watcher.includes("batchGetIntradayMonitoringOHLC"))
assert(!watcher.includes("batchGetIntradayOHLC("))
assert(intradayData.includes("return fetchShioajiMonitoringQuotes(uniqueSymbols, env)"))
assert(callback.includes("s12_intraday_setup_watch_complete"))
assert(orchestrator.includes("triggerPendingS12FormalEv"))

console.log('intraday durable watcher contract tests passed')
