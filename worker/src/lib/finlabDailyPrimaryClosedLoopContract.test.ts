import fs from 'node:fs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const wranglerToml = fs.readFileSync('wrangler.toml', 'utf8')
const backfillTool = fs.readFileSync('../tools/finlab_v4_remote_backfill.py', 'utf8')
const stocksRoute = fs.readFileSync('src/routes/stocks.ts', 'utf8')
const otherRoute = fs.readFileSync('src/routes/other.ts', 'utf8')
const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const localMaintenance = fs.readFileSync('src/lib/localMaintenance.ts', 'utf8')
const marketRisk = fs.readFileSync('src/lib/marketRisk.ts', 'utf8')
const mlPipelineTrigger = fs.readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')
const dataQualityMonitor = fs.readFileSync('src/lib/dataQualityMonitor.ts', 'utf8')
const deployGate = fs.readFileSync('src/lib/deployGate.ts', 'utf8')
const marketDataReadiness = fs.readFileSync('src/lib/marketDataReadiness.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const v41DataRuntime = fs.readFileSync('src/lib/v41DataRuntime.ts', 'utf8')
const observabilityEvents = fs.readFileSync('src/lib/observabilityEvents.ts', 'utf8')
const observabilityPage = fs.readFileSync('../frontend/src/pages/ObservabilityPage.tsx', 'utf8')
const datasetSnapshots = fs.readFileSync('src/lib/datasetSnapshots.ts', 'utf8')

const requiredDailyLanes = [
  'daily_price',
  'emerging_price_diversity',
  'chip_diversity',
  'institutional_amount_summary',
  'emerging_chip_diversity',
]
const requiredCanonical = [
  'canonical_market_daily',
  'canonical_chip_daily',
  'canonical_institutional_amount_daily',
  'canonical_broker_flow_daily',
]

for (const lane of requiredDailyLanes) {
  assert(
    wranglerToml.includes(lane) && workflows.includes(lane) && backfillTool.includes(`lane="${lane}"`),
    `FinLab daily primary must include and support lane=${lane}`,
  )
}

for (const dataset of requiredCanonical) {
  assert(
    wranglerToml.includes(dataset) && workflows.includes(dataset) && backfillTool.includes(dataset),
    `FinLab daily primary must materialize dataset=${dataset}`,
  )
}

assert(
  stocksRoute.includes('loadCanonicalStockChips') &&
    stocksRoute.includes('canonical_chip_daily') &&
    stocksRoute.includes('canonical-first') &&
    stocksRoute.includes('fallback_reason'),
  'Stock chip/margin routes must read FinLab canonical rows first and expose legacy fallback reason',
)

assert(
  marketRisk.includes('fetchCanonicalMarketForeignChip') &&
    marketRisk.includes('canonical_chip_daily') &&
    marketRisk.includes('canonical_market_daily') &&
    marketRisk.includes('legacy.chip_data fallback'),
  'Market risk foreign-chip input must be FinLab canonical-first before legacy chip_data fallback',
)

assert(
  otherRoute.includes('canonical_chip_latest') &&
    otherRoute.includes('canonical_chip_daily') &&
    otherRoute.includes('chip_source') &&
    otherRoute.includes('legacy.chip_data'),
  'System status chip freshness must be FinLab canonical-first and expose legacy fallback source',
)

assert(
  marketScreener.includes('FROM canonical_chip_daily') &&
    marketScreener.includes('legacy.chip_data'),
  'Screener market-wide foreign-flow overlay must be FinLab canonical-first before legacy chip_data fallback',
)

assert(
  localMaintenance.includes('readCanonicalFirstStockChips') &&
    localMaintenance.includes('FROM canonical_chip_daily') &&
    localMaintenance.includes('legacy.chip_data'),
  'Weekly IC/drift maintenance jobs must feed ML diagnostics with FinLab canonical chips before legacy chip_data fallback',
)

assert(
  mlPipelineTrigger.includes("market:risk:latest:v6-null-safe-factor-packet"),
  'ML pipeline risk refresh must invalidate the current homepage market-risk KV cache key',
)

assert(
  marketDataReadiness.includes('requireInstitutionalAmount') &&
    marketDataReadiness.includes('canonical_institutional_amount_daily') &&
    updateOrchestrator.includes('requireInstitutionalAmount: true'),
  'FinLab evening-chain continuation must gate on official institutional amount freshness, not only price/chip',
)

assert(
  dataQualityMonitor.includes('institutional_amount_freshness') &&
    dataQualityMonitor.includes('canonical_institutional_amount_daily') &&
    dataQualityMonitor.includes("source: 'canonical_institutional_amount_daily'"),
  'Data Quality must surface official FinLab institutional amount freshness independently from chip freshness',
)

assert(
  deployGate.includes('canonical_market_daily') &&
    deployGate.includes('canonical_chip_daily') &&
    deployGate.includes('canonical_institutional_amount_daily') &&
    deployGate.includes('canonical_broker_flow_daily') &&
    deployGate.includes('required_canonical_datasets'),
  'Deploy gate must read back the full FinLab daily-primary canonical dataset set before production promotion',
)

assert(
  v41DataRuntime.includes('canonical_institutional_amount_daily') &&
    v41DataRuntime.includes('canonical_broker_flow_daily') &&
    v41DataRuntime.includes('institutional_amount_daily') &&
    v41DataRuntime.includes('broker_flow_daily'),
  'V4.1 runtime status must expose FinLab institutional amount and broker-flow canonical row counts',
)

assert(
  observabilityEvents.includes("check.id === 'chip_freshness'") &&
    observabilityEvents.includes("check.id === 'institutional_amount_freshness'") &&
    observabilityEvents.includes('FINLAB_DAILY_PRICE_LANES') &&
    observabilityEvents.includes('canonical_institutional_amount_daily'),
  'OBS data-quality events must route chip/institutional freshness failures to FinLab daily-primary lane and canonical dataset checks',
)

assert(
  observabilityPage.includes('focus=chip_freshness') &&
    observabilityPage.includes('focus=institutional_amount_freshness'),
  'OBS operational drilldown must expose direct links for chip and institutional amount freshness, not only price freshness',
)

assert(
  datasetSnapshots.includes('canonical_market_daily_hot_window') &&
    datasetSnapshots.includes('canonical_chip_daily_hot_window') &&
    datasetSnapshots.includes('canonical_institutional_amount_daily_hot_window') &&
    datasetSnapshots.includes('canonical_broker_flow_daily_hot_window') &&
    datasetSnapshots.includes("table: 'canonical_market_daily', dateColumn: 'date', archiveRequired: true") &&
    datasetSnapshots.includes("table: 'canonical_chip_daily', dateColumn: 'date', archiveRequired: true") &&
    datasetSnapshots.includes("table: 'canonical_institutional_amount_daily', dateColumn: 'date', archiveRequired: true") &&
    datasetSnapshots.includes("table: 'canonical_broker_flow_daily', dateColumn: 'date', archiveRequired: true"),
  'D1 hot-window manifests must record FinLab canonical daily-primary datasets, not only legacy chip_data/margin_data',
)
