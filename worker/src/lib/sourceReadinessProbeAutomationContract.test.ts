import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const controllerResearchWorkflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')
const schedulerStatus = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
const frontendApi = fs.readFileSync('../frontend/src/lib/api.ts', 'utf8')
const observabilityPage = fs.readFileSync('../frontend/src/pages/ObservabilityPage.tsx', 'utf8')
const finlabRouter = fs.readFileSync('../ml-controller/routers/finlab.py', 'utf8')
const modalApp = fs.readFileSync('../ml-service/modal_app.py', 'utf8')

assert(
  controllerResearchWorkflows.includes('dailySourceRefresh?: boolean') &&
    controllerResearchWorkflows.includes("callbackMode?: 'readiness_probe' | 'evening_chain'") &&
    controllerResearchWorkflows.includes('options.dailySourceRefresh || options.continueEveningChain') &&
    controllerResearchWorkflows.includes('daily_source_refresh: dailySourceMode') &&
    controllerResearchWorkflows.includes('callback_mode: callbackMode') &&
    controllerResearchWorkflows.includes("mode: dailySourceMode ? 'daily_price_primary' : 'archive_backfill'"),
  'FinLab trigger payload must separate daily source refresh from direct evening-chain continuation',
)

assert(
  finlabRouter.includes('daily_source_refresh: bool = False') &&
    finlabRouter.includes('callback_mode: str | None = None') &&
    modalApp.includes('"daily_source_refresh": bool(payload.get("daily_source_refresh"))') &&
    modalApp.includes('"callback_mode": payload.get("callback_mode")'),
  'ml-controller/modal callback contract must round-trip daily source refresh and callback mode',
)

assert(
  updateOrchestrator.includes("'source_readiness_recheck'") &&
    types.includes("| 'source_readiness_recheck'") &&
    updateOrchestrator.includes('scheduleSourceReadinessRecheck') &&
    updateOrchestrator.includes('source-readiness:finlab-refresh') &&
    updateOrchestrator.includes('ignoreEveningChainInFlight') &&
    updateOrchestrator.includes("callbackMode: 'readiness_probe'") &&
    updateOrchestrator.includes('dailySourceRefresh: true'),
  'source-readiness-probe must trigger FinLab daily refresh and automatically queue a recheck callback without self-blocking on the same evening-chain run',
)

assert(
  updateOrchestrator.includes("'canonical_market_summary_daily:listed_otc'") &&
    updateOrchestrator.includes("'canonical_broker_flow_daily:listed_otc'") &&
    updateOrchestrator.includes("'canonical_broker_rank_daily:listed_otc'") &&
    updateOrchestrator.includes("source = 'finlab.broker_transactions'") &&
    updateOrchestrator.includes("market_segment = 'LISTED_OTC'") &&
    updateOrchestrator.includes('assertFinLabCanonicalReadinessReady') &&
    updateOrchestrator.includes('source readiness not ready after refresh'),
  'readiness must validate target-date market summary and FinLab broker lanes before advancing the chain',
)

assert(
  adminControlRoutes.includes('callback_mode') &&
    adminControlRoutes.includes("callbackMode === 'readiness_probe'") &&
    adminControlRoutes.includes("type: 'source_readiness_recheck'") &&
    adminControlRoutes.includes('FinLab daily source refresh completed'),
  'FinLab callback route must route readiness-probe callbacks to source readiness rechecks',
)

assert(
  schedulerStatus.includes('details: lastLog?.details ?? []') &&
    frontendApi.includes('details?: string[]') &&
    observabilityPage.includes('schedulerReadinessDetails') &&
    observabilityPage.includes('/canonical_|official_supplemental|finlab_/i') &&
    observabilityPage.includes('stage.job.details') &&
    observabilityPage.includes("detail.replace(/^ok\\s+/i, '')"),
  'OBS scheduler UI must surface lane-level readiness details instead of only run-level status',
)
