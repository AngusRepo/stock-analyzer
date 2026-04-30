const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const pendingBuyOrchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const screenerMarketData = fs.readFileSync('src/lib/screenerMarketData.ts', 'utf8')
const screenerStrategyConsumer = fs.readFileSync('src/lib/screenerStrategyConsumer.ts', 'utf8')
const strategySpec = fs.readFileSync('src/lib/strategySpec.ts', 'utf8')
const strategyOwnerFreeze = fs.readFileSync('src/lib/strategyOwnerFreeze.ts', 'utf8')
const strategyLab = fs.readFileSync('src/lib/strategyLab.ts', 'utf8')
const researchExperimentRegistry = fs.readFileSync('src/lib/researchExperimentRegistry.ts', 'utf8')
const researchInternGate = fs.readFileSync('src/lib/researchInternGate.ts', 'utf8')
const researchEvaluationPlan = fs.readFileSync('src/lib/researchEvaluationPlan.ts', 'utf8')
const stocksRoute = fs.readFileSync('src/routes/stocks.ts', 'utf8')

{
  assert(fs.existsSync('src/lib/screenerMarketData.ts'), 'screener market data loader should live in its own domain module')
  assert(marketScreener.includes("from './screenerMarketData'"), 'marketScreener should import the market data loader module')
  assert(!marketScreener.includes('async function loadMarketDataFromD1'), 'marketScreener should not own D1 market data loading')
}

{
  assert(!marketScreener.includes("../routes/stocks"), 'screener lib must not import route modules')
  assert(!marketScreener.includes("from './stocks'"), 'screener lib must not import stocks route')
  assert(marketScreener.includes("from './technicalIndicators'"), 'screener should use technical indicator domain service')
  assert(screenerMarketData.includes('isAutoTradablePriceRow'), 'screener market data must own auto-tradable universe filtering')
  assert(pendingBuyOrchestrator.includes("COALESCE(s.market, '') != 'EMERGING'"), 'pending-buy setup must exclude explicit emerging-board stocks')
  assert(pendingBuyOrchestrator.includes('sp_exec.open'), 'pending-buy setup must reject emerging-style rows without an executable open price')
}

{
  assert(marketScreener.includes("from './screenerStrategyConsumer'"), 'marketScreener should consume strategy specs through the screener strategy consumer')
  assert(screenerStrategyConsumer.includes("from './strategySpec'"), 'screener strategy consumer should read the strategy spec contract')
  assert(screenerStrategyConsumer.includes("from './strategyOwnerFreeze'"), 'screener strategy consumer should enforce owner freeze')
  assert(strategyOwnerFreeze.includes('STRATEGY_OWNER_BOUNDARIES'), 'owner freeze must be explicit and testable')
  assert(!strategySpec.includes('../routes/'), 'strategy spec must not import route modules')
  assert(!/from ['"].*pendingBuy/i.test(strategySpec), 'strategy spec must not import pending-buy orchestration')
  assert(!/from ['"].*paper|from ['"].*execution/i.test(strategySpec), 'strategy spec must not import execution modules')
  assert(!strategyLab.includes('../routes/'), 'strategy lab MVP must not import routes')
  assert(!strategyLab.includes('env.DB'), 'strategy lab MVP should stay pure until a route/controller is intentionally added')
  assert(researchExperimentRegistry.includes('can_retrain_prod: false'), 'research registry must explicitly block prod retrain')
  assert(researchExperimentRegistry.includes('can_promote: false'), 'research registry must explicitly block promote')
  assert(researchExperimentRegistry.includes('can_deploy: false'), 'research registry must explicitly block deploy')
  assert(researchExperimentRegistry.includes('can_trade: false'), 'research registry must explicitly block trading')
  assert(!/controllerFetch|runWeeklyRetrain|promoteSandbox|setTradingConfig/.test(researchExperimentRegistry), 'research registry must not call production mutation workflows')
  assert(researchInternGate.includes("'deploy_prod'"), 'research gate must explicitly model deploy attempts')
  assert(researchInternGate.includes('FORBIDDEN_ACTIONS'), 'research gate must keep forbidden action list explicit')
  assert(!/controllerFetch|runWeeklyRetrain|promoteSandbox|setTradingConfig|env\.DB|KV\.put/.test(researchInternGate), 'research gate must stay pure and not call mutation workflows')
  assert(researchEvaluationPlan.includes("mode: 'dry_run_only'"), 'research evaluation plan must stay dry-run only')
  assert(researchEvaluationPlan.includes('mutation_allowed: false'), 'research evaluation plan must mark every step non-mutating')
  assert(!/controllerFetch|runWeeklyRetrain|promoteSandbox|setTradingConfig|env\.DB|KV\.put/.test(researchEvaluationPlan), 'research evaluation plan must not execute workflows directly')
}

{
  assert(!stocksRoute.includes('function computeTechnicalIndicators'), 'stocks route must not own indicator formula implementation')
  assert(stocksRoute.includes("../lib/technicalIndicators"), 'stocks route should call technical indicator domain service')
}
