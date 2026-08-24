import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseTaifexQuoteBody } from './twseApi'

const quote = parseTaifexQuoteBody({
  RtData: {
    QuoteList: [
      { SymbolID: 'TXFI6-M', CLastPrice: '44520', CRefPrice: '44740', CDate: '20260824', CTime: '013000' },
      { SymbolID: 'TXFI6-F', CLastPrice: '44900', CRefPrice: '44740', CDate: '20260824', CTime: '134500' },
    ],
  },
}, '1')
assert(quote)
assert.equal(quote.lastPrice, 44520)
assert.equal(quote.changePoints, -220)
assert(Math.abs(quote.changePct - (-220 / 44740 * 100)) < 1e-12)

const workerIndex = fs.readFileSync('src/index.ts', 'utf8')
const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
assert.doesNotMatch(workerIndex, /strategyDiscoveryRoutes|StrategyDiscoveryWorkflow/)
assert.doesNotMatch(wrangler, /strategy-discovery-analysis|STRATEGY_DISCOVERY_WORKFLOW/)

const research = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
assert.match(research, /const opsDb = databaseForDataDomain\(env, 'ops'\)/)
assert.match(research, /acquireOptunaQueueProcessorD1Lock\(opsDb/)
assert.doesNotMatch(research, /OptunaQueueProcessorD1Lock\(env\.DB/)
assert.match(research, /acquireOptunaRunD1Lock\(opsDb/)
assert.doesNotMatch(research, /acquireOptunaRunD1Lock\(env\.DB/)
assert.match(fs.readFileSync('src/lib/adaptiveEngine.ts', 'utf8'), /evaluateGaPromotion\(latest\)/)

const lifecycle = fs.readFileSync('src/lib/artifactLifecycle.ts', 'utf8')
assert.match(lifecycle, /frozenDomainReceipt = await env\.DB\.prepare/)
assert.match(lifecycle, /\(!legacyRetentionStalled \|\| legacyFrozenRollbackSource\)/)

const twse = fs.readFileSync('src/lib/twseApi.ts', 'utf8')
assert.match(twse, /bulkFetchAndStorePrices\([\s\S]*marketDb: D1Database,[\s\S]*identityDb: D1Database/)
assert.match(twse, /identityDb\.prepare\('SELECT id, symbol FROM stocks'\)/)
assert.match(twse, /marketDb\.prepare\([\s\S]*INSERT INTO stock_prices/)
assert.match(twse, /marketDb\.batch\(stmts\)/)
assert.match(twse, /\/taifex-quote/)
assert.match(twse, /X-Controller-Token/)

const orchestration = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert.match(orchestration, /bulkFetchAndStorePrices\([\s\S]*databaseForDataDomain\(env, 'market'\),[\s\S]*databaseForDataDomain\(env, 'core'\)/)
assert.match(orchestration, /fetchTaifexNightClose\(env\.ML_CONTROLLER_URL, env\.ML_CONTROLLER_SECRET\)/)

const recommendations = fs.readFileSync('src/routes/other.ts', 'utf8')
const cardPolicyStart = recommendations.indexOf('const CARD_RECOMMENDATION_ROW_WHERE')
const cardPolicyEnd = recommendations.indexOf('function isEmergingRecommendation', cardPolicyStart)
assert(cardPolicyStart >= 0 && cardPolicyEnd > cardPolicyStart)
const cardPolicy = recommendations.slice(cardPolicyStart, cardPolicyEnd)
assert.doesNotMatch(cardPolicy, /\bLIMIT\b|ROW_NUMBER|RANK\(/i, 'card eligibility must not introduce Top-K admission')
assert.match(cardPolicy, /json_valid\(r\.alpha_allocation\)/, 'card SQL must fail-soft on malformed legacy JSON')
const sqlFilter = recommendations.indexOf("view === 'card' ? CARD_RECOMMENDATION_ROW_WHERE")
const hydration = recommendations.indexOf('const symbolsForHydration')
assert(sqlFilter >= 0 && hydration > sqlFilter, 'card candidate filter must execute before hydration')
assert.match(recommendations, /stockIds\.length > 0 && view !== 'card'/)
assert.match(recommendations, /symbolsForHydration\.length && view !== 'card'/)
assert.equal((recommendations.match(/resultSymbols\.length > 0 && view !== 'card'/g) ?? []).length, 2)
assert.match(recommendations, /const evidenceLinksBySymbol = view === 'card'/)
assert.match(recommendations, /if \(view !== 'card'\) \{\s*try \{\s*pipelineSummaries = await buildDailyPipelineSummaries/)
assert.match(recommendations, /market:indices:finlab-clean:v17-taifex-controller-live-night/)

console.log('aug25 operations closure tests passed')
