import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const controllerResearchWorkflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const finlabSourceContract = fs.readFileSync('src/lib/finlabSourceContract.ts', 'utf8')
const officialMarketSummaryRefresh = fs.readFileSync('src/lib/officialMarketSummaryRefresh.ts', 'utf8')
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
    controllerResearchWorkflows.includes('keyScopeJson?: string') &&
    controllerResearchWorkflows.includes('reuseSuccessfulArtifacts?: boolean') &&
    controllerResearchWorkflows.includes('key_scope_json: optionalString(options.keyScopeJson)') &&
    controllerResearchWorkflows.includes('reuse_successful_artifacts: Boolean(options.reuseSuccessfulArtifacts)') &&
    controllerResearchWorkflows.includes('options.dailySourceRefresh || options.continueEveningChain') &&
    controllerResearchWorkflows.includes('daily_source_refresh: dailySourceMode') &&
    controllerResearchWorkflows.includes('callback_mode: callbackMode') &&
    controllerResearchWorkflows.includes('source_start_date: sourceStartDate') &&
    controllerResearchWorkflows.includes('source_end_date: sourceEndDate') &&
    controllerResearchWorkflows.includes('buildFinLabBackfillRunId(years, runDate, dailySourceMode)') &&
    controllerResearchWorkflows.includes("const mode = dailySourceRefresh ? 'daily' : `${years}y`") &&
    controllerResearchWorkflows.includes('FinLab daily source refresh requires YYYY-MM-DD runDate') &&
    controllerResearchWorkflows.includes('canonical_window_days: dailySourceMode ? 1 : finLabCanonicalWindowDays(env)') &&
    controllerResearchWorkflows.includes('source_window_days: dailySourceMode ? 1 : undefined') &&
    controllerResearchWorkflows.includes('controller returned non-json for finlab backfill') &&
    !controllerResearchWorkflows.includes('require_official_market_summary: dailySourceMode') &&
    !controllerResearchWorkflows.includes('market_summary,global_context') &&
    controllerResearchWorkflows.includes("const FINLAB_DAILY_PRIMARY_LANES_DEFAULT = 'daily_price,chip_diversity,institutional_amount_summary,broker_flow_diversity,regime_context,trading_restrictions'") &&
    !controllerResearchWorkflows.includes('FINLAB_DAILY_PRIMARY_LANES_DEFAULT = \'daily_price,chip_diversity,institutional_amount_summary,broker_flow_diversity,global_context') &&
    controllerResearchWorkflows.includes('canonical_broker_rank_daily,canonical_trading_restrictions') &&
    controllerResearchWorkflows.includes('FINLAB_BACKFILL_LANES must be set for archive backfill') &&
    !controllerResearchWorkflows.includes('canonical_market_summary_daily,canonical_regime_context_daily') &&
    controllerResearchWorkflows.includes('canonical_start_date: canonicalStartDate') &&
    controllerResearchWorkflows.includes("mode: dailySourceMode ? 'daily_price_primary' : 'archive_backfill'"),
  'FinLab trigger payload must separate daily one-day source refresh from direct evening-chain continuation',
)

assert(
  finlabRouter.includes('daily_source_refresh: bool = False') &&
    finlabRouter.includes('callback_mode: str | None = None') &&
    finlabRouter.includes('source_start_date: str | None = None') &&
    finlabRouter.includes('source_end_date: str | None = None') &&
    finlabRouter.includes('key_scope_json: str | None = None') &&
    finlabRouter.includes('reuse_successful_artifacts: bool = False') &&
    finlabRouter.includes('require_official_market_summary: bool = False') &&
    modalApp.includes('"--source-start-date"') &&
    modalApp.includes('"--source-end-date"') &&
    modalApp.includes('"--key-scope-json"') &&
    modalApp.includes('"--reuse-successful-artifacts"') &&
    modalApp.includes('"--require-official-market-summary"') &&
    modalApp.includes('"daily_source_refresh": bool(payload.get("daily_source_refresh"))') &&
    modalApp.includes('"callback_mode": payload.get("callback_mode")'),
  'ml-controller/modal callback contract must round-trip daily source refresh and callback mode',
)

assert(
  updateOrchestrator.includes("'source_readiness_recheck'") &&
    types.includes("| 'source_readiness_recheck'") &&
    updateOrchestrator.includes('scheduleSourceReadinessRecheck') &&
    updateOrchestrator.includes('source-readiness:finlab-refresh') &&
    updateOrchestrator.includes('runOfficialMarketSummaryRefresh') &&
    updateOrchestrator.includes('official-market-summary-refresh') &&
    updateOrchestrator.includes('hasOfficialMarketSummaryMissing') &&
    updateOrchestrator.includes('ignoreEveningChainInFlight') &&
    updateOrchestrator.includes("callbackMode: 'readiness_probe'") &&
    updateOrchestrator.includes('finLabRefreshScopeForReadiness') &&
    updateOrchestrator.includes('finLabRetryScopeForReadiness') &&
    updateOrchestrator.includes('readFinLabSourceKeyReportForTarget') &&
    updateOrchestrator.includes('source_key_report') &&
    updateOrchestrator.includes('finLabSentinelFieldForLane') &&
    updateOrchestrator.includes('finLabRequiredFieldsForLane') &&
    updateOrchestrator.includes('finLabContractFlagDefault') &&
    updateOrchestrator.includes('FINLAB_KEY_REPORT_ENABLED') &&
    updateOrchestrator.includes('FINLAB_KEY_LEVEL_RETRY_ENABLED') &&
    updateOrchestrator.includes('FINLAB_ARTIFACT_REUSE_ENABLED') &&
    updateOrchestrator.includes('keyScopeJson: refreshScope.keyScopeJson') &&
    updateOrchestrator.includes('reuseSuccessfulArtifacts: finLabArtifactReuseEnabled(env) && Boolean(refreshScope.keyScopeJson)') &&
    updateOrchestrator.includes('retry_keys=') &&
    updateOrchestrator.includes('skipped_ok_keys=') &&
    updateOrchestrator.includes('sentinel_keys=') &&
    updateOrchestrator.includes('quota_blocked_keys=') &&
    updateOrchestrator.includes('materialized_datasets=') &&
    updateOrchestrator.includes('blocked_datasets=') &&
    updateOrchestrator.includes('fetchedFinLabSourceLanesForTarget') &&
    updateOrchestrator.includes('source_diff_report') &&
    updateOrchestrator.includes("run_id LIKE ?") &&
    updateOrchestrator.includes("finlab-v4-daily-${targetDate.replace(/-/g, '')}-%") &&
    updateOrchestrator.includes('canonical_apply_pending_no_refetch') &&
    updateOrchestrator.includes('skipped_fetched_lanes=') &&
    updateOrchestrator.includes('isFinLabQuotaLimitLog') &&
    updateOrchestrator.includes('quota_exhausted_no_refetch') &&
    updateOrchestrator.includes('Usage exceed|quota|VIP program') &&
    updateOrchestrator.includes('22:00 fallback skipped FinLab refresh') &&
    updateOrchestrator.includes('22:00 fallback waiting at non-FinLab source-readiness gate') &&
    updateOrchestrator.includes('22:00 fallback skipped FinLab data.get refetch') &&
    updateOrchestrator.includes('malformed scheduler run log ignored') &&
    !updateOrchestrator.includes("lanes.add('market_summary')") &&
    updateOrchestrator.includes("'canonical_market_daily:listed_otc'") &&
    updateOrchestrator.includes("'canonical_chip_daily:listed_otc'") &&
    updateOrchestrator.includes("'canonical_institutional_amount_daily:listed_otc'") &&
    updateOrchestrator.includes("if (key.startsWith('canonical_market_daily:'))") &&
    updateOrchestrator.includes("if (key.startsWith('canonical_chip_daily:'))") &&
    updateOrchestrator.includes("if (key.startsWith('canonical_institutional_amount_daily:'))") &&
    updateOrchestrator.includes("'canonical_trading_restrictions:daily_micro_lane'") &&
    updateOrchestrator.includes("if (key.startsWith('canonical_trading_restrictions:'))") &&
    updateOrchestrator.includes("lanes.add('trading_restrictions')") &&
    updateOrchestrator.includes("datasets.add('canonical_trading_restrictions')") &&
    updateOrchestrator.includes("datasets.add('canonical_broker_rank_daily')") &&
    updateOrchestrator.includes('dailySourceRefresh: true'),
  'source-readiness-probe must trigger FinLab daily refresh and automatically queue a recheck callback without self-blocking on the same evening-chain run',
)

assert(
  finlabSourceContract.includes("../../../data/finlab_source_contract.json") &&
    finlabSourceContract.includes('FINLAB_SOURCE_CONTRACT') &&
    finlabSourceContract.includes('finLabCanonicalDatasetsForLane') &&
    finlabSourceContract.includes('finLabRequiredFieldsForLane') &&
    finlabSourceContract.includes('finLabSentinelFieldForLane') &&
    fs.readFileSync('../data/finlab_source_contract.json', 'utf8').includes('"FINLAB_KEY_REPORT_ENABLED": true') &&
    fs.readFileSync('../data/finlab_source_contract.json', 'utf8').includes('"FINLAB_KEY_LEVEL_RETRY_ENABLED": false') &&
    fs.readFileSync('../data/finlab_source_contract.json', 'utf8').includes('"FINLAB_ARTIFACT_REUSE_ENABLED": false') &&
    fs.readFileSync('../data/finlab_source_contract.json', 'utf8').includes('"institutional_amount_summary"') &&
    fs.readFileSync('../data/finlab_source_contract.json', 'utf8').includes('"buy_amount"'),
  'FinLab source contract must be shared by Worker and Python with report-on/retry-off/reuse-off defaults',
)

assert(
  officialMarketSummaryRefresh.includes('runOfficialMarketSummaryRefresh') &&
    officialMarketSummaryRefresh.includes('canonical_market_summary_daily') &&
    officialMarketSummaryRefresh.includes('validateTargetDateRows') &&
    officialMarketSummaryRefresh.includes('twse.mi_margn.official') &&
    officialMarketSummaryRefresh.includes('tpex.margin_balance.official') &&
    officialMarketSummaryRefresh.includes('/www/zh-tw/margin/balance') &&
    officialMarketSummaryRefresh.includes('arrayValueByHeader') &&
    officialMarketSummaryRefresh.includes('deriveOtcSummaryFromCanonicalChip') &&
    officialMarketSummaryRefresh.includes('finlab.canonical_chip_minus_twse') &&
    officialMarketSummaryRefresh.includes('official_market_summary_missing'),
  'official market summary refresh must be an independent TWSE/TPEX canonical owner',
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
    observabilityPage.includes('retry_keys|skipped_ok_keys|sentinel_keys|quota_blocked_keys|materialized_datasets|blocked_datasets') &&
    observabilityPage.includes('stage.job.details') &&
    observabilityPage.includes("detail.replace(/^ok\\s+/i, '')"),
  'OBS scheduler UI must surface lane-level readiness details instead of only run-level status',
)
