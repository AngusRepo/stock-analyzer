import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const entry = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const exit = readFileSync('src/lib/paperExitTasks.ts', 'utf8')
const chain = readFileSync('src/lib/riskChain.ts', 'utf8')
const pending = readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const route = readFileSync('src/routes/other.ts', 'utf8')
const pipeline = readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')

assert(entry.includes('const baseCb = await checkCircuitBreakersForDomains'), 'intraday buy must evaluate the multi-D1 strict circuit breaker before orders')
assert(entry.includes('readP9IntradayHalt'), 'intraday buy must consume the same-day latched P9 state after exit polling')
assert(entry.includes('resolveCircuitAdjustedSingleNameCap'), 'circuit scale must reach final five-slot order sizing without becoming an unintended absolute NAV cap')
assert(entry.includes('targetExposureCap: cb.targetExposurePct'), 'canonical total-exposure cap must reach the allocator')
assert(!entry.includes("KV.get('market:risk_level')"), 'dead legacy market:risk_level consumer must be removed')
assert(!entry.includes('SHIOAJI_PROXY_URL}/market-risk'), 'paper entry must not use an independent proxy risk owner')

assert(chain.includes('resolveCanonicalMarketRisk'), 'P3/P4 must share one canonical market-risk resolution')
assert(chain.includes('core: databases.core'), 'canonical risk must read market_risk from CORE_DB')
assert(chain.includes('market: databases.market'), 'canonical risk must read packet and breadth from MARKET_DB')
assert(!pending.includes("risk:use_chain"), 'legacy early-return risk bypass must be removed')
assert(exit.includes('checkP9IntradayDrawdown'), 'intraday portfolio NAV drawdown P9 must be implemented')
assert(exit.includes('buildPortfolioDeRiskPlan'), 'existing holdings must consume the portfolio target exposure')
assert(exit.includes('owner=canonical_market_risk_runtime_v1'), 'portfolio de-risk exits must preserve canonical owner lineage')

assert(!route.includes('await buildMarketRegimeFactorPacket(databaseForDataDomain(c.env'), 'GET /market/risk must not recompute or write a packet')
assert(route.includes('const packetByDate = new Map'), 'risk history must merge the same materialized packet as current risk across domain DBs')
assert(pipeline.includes('market:risk:latest:v20-finlab-risk-detail-oi-delta'), 'evening materialization must clear the current served cache key')
