import assert from 'node:assert/strict'
import fs from 'node:fs'

function source(name: string): string {
  return fs.readFileSync(`src/lib/${name}`, 'utf8')
}

const riskChain = source('riskChain.ts')
const pending = source('pendingBuyOrchestrator.ts')
const entry = source('paperEntryTasks.ts')
const exit = source('paperExitTasks.ts')
const postExit = source('postExit.ts')

for (const required of [
  'checkP1Mdd(databases.paper',
  'checkP2Accuracy(databases.learning',
  'checkP3MarketRisk(databases.core',
  'checkP4Breadth(databases.market',
  'checkP5Losses(databases.paper',
  'checkP6Momentum(databases.market',
  'checkP7Streak(databases.learning',
  'checkP8DailyPnl(databases.paper',
]) assert(riskChain.includes(required), `missing domain-aware risk mapping: ${required}`)

assert(
  pending.includes('checkP6Momentum(databases.market'),
  'Pending-buy sequential fallback must read P6 momentum from Market D1',
)

for (const domain of ['paper', 'core', 'market', 'learning']) {
  assert(
    pending.includes(`${domain}: databaseForDataDomain(env, '${domain}')`),
    `Circuit Breaker wrapper must resolve ${domain} D1`,
  )
}
assert(pending.includes("writeAuditEntry(databaseForDataDomain(env, 'execution')"))
assert(exit.includes("writeAuditEntry(databaseForDataDomain(env, 'execution')"))

for (const runtime of [entry, exit]) {
  assert(!runtime.includes('recordSellSettlement(env.DB'))
  assert(!runtime.includes('batchGetATR(env.DB'))
}
assert(!entry.includes('getUnsettledSettlementSummary(env.DB'))
assert(!entry.includes('getAvailCash(env.DB'))
assert(!entry.includes('batchGetLatestPrices(env.DB'))

assert(postExit.includes('env: Bindings'))
assert(postExit.includes('paperDomainDatabase(ctx.env)'))
assert(postExit.includes("databaseForDataDomain(ctx.env, 'core')"))
assert(postExit.includes('loadPendingBuySnapshot(ctx.env'))
assert(postExit.includes('appendPendingBuy(ctx.env'))
assert(!postExit.includes('ctx as any'))

console.log('paper domain runtime closure contracts passed')
