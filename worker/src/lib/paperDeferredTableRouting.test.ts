import assert from 'node:assert/strict'
import fs from 'node:fs'

const registry = fs.readFileSync('src/lib/dataDomainRegistry.ts', 'utf8')
const pendingStore = fs.readFileSync('src/lib/pendingBuyStore.ts', 'utf8')
const pendingOrchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const entry = fs.readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const exit = fs.readFileSync('src/lib/paperExitTasks.ts', 'utf8')
const challenger = fs.readFileSync('src/lib/paperActiveChallenger.ts', 'utf8')
const dashboard = fs.readFileSync('src/routes/dashboardReadRoutes.ts', 'utf8')
const adminTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const cronTasks = fs.readFileSync('src/lib/cronWorkerDomainTasks.ts', 'utf8')

assert(registry.includes('if (!ownership.route_ready) return env.DB'))
for (const table of [
  'debate_memory', 'decision_logs', 'exit_shadow_log', 'pending_buy_filter_audit',
  'pending_buy_items', 'pending_buy_runs', 'promotion_audit_events',
]) {
  assert.match(registry, new RegExp(`table: '${table}'.*route_ready: true`))
}
assert(pendingStore.includes("return databaseForTable(env, 'pending_buy_runs')"))
assert(pendingStore.includes('loadLatestPendingBuyIntradayEvents(paperDomainDatabase(env)'))
assert(pendingOrchestrator.includes("databaseForTable(env, 'pending_buy_filter_audit')"))
assert(entry.includes("databaseForTable(env, 'decision_logs')"))
assert(!exit.includes('exit_shadow_log'), 'retired regime shadow writes must not be restored after S12 exit governance takeover')
assert(challenger.includes("databaseForTable(env, 'promotion_audit_events')"))
assert(dashboard.includes("databaseForTable(c.env, 'decision_logs')"))
assert(adminTasks.includes("databaseForTable(c.env, 'debate_memory')"))
assert(cronTasks.includes("databaseForTable(env, 'debate_memory')"))

console.log('paper deferred table routing fail-safe contracts passed')
