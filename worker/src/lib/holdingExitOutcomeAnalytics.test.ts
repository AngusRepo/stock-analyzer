import {
  buildHoldingExitOutcomeAnalytics,
  parseHoldingExitOutcomeEvent,
} from './holdingExitOutcomeAnalytics'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const events = [
  {
    trade_date: '2026-05-29',
    symbol: '2408',
    event_type: 'holding_exit_outcome',
    detail_json: JSON.stringify({
      observation: {
        tradeDate: '2026-05-29',
        symbol: '2408',
        orderId: 66,
        finalAction: 'move_tp2',
        baselineAction: 'full_sell',
        reward: 0.42,
        rewardBasis: 'counterfactual_delta',
        counterfactualRewardScore: 0.25,
        realizedReturnPct: 0.11,
        baselineReturnPct: 0.08,
        baselineExitPrice: 108,
        activeVsBaselineReturnDeltaPct: 0.03,
        activeVsBaselineReturnDeltaAmount: 6000,
        exitShareRatio: 1,
        learningImpactWeight: 1,
        featureQualityCoverage: 0.67,
        flowEvidenceCoverage: 0.6667,
        missingFeatureGroups: ['brokerFlow'],
        profitRetention: 0.86,
        regime: 'bull',
        exitSource: 'eod_exit',
      },
    }),
    created_at: '2026-05-29T06:00:00Z',
  },
  {
    trade_date: '2026-05-29',
    symbol: '2408',
    event_type: 'holding_exit_outcome',
    order_id: 66,
    detail_json: JSON.stringify({
      observation: {
        tradeDate: '2026-05-29',
        symbol: '2408',
        finalAction: 'move_tp2',
        baselineAction: 'full_sell',
        reward: 0.42,
        rewardBasis: 'counterfactual_delta',
        counterfactualRewardScore: 0.25,
        realizedReturnPct: 0.11,
        baselineReturnPct: 0.08,
        baselineExitPrice: 108,
        activeVsBaselineReturnDeltaPct: 0.03,
        activeVsBaselineReturnDeltaAmount: 6000,
        exitShareRatio: 1,
        learningImpactWeight: 1,
        featureQualityCoverage: 0.67,
        flowEvidenceCoverage: 0.6667,
        missingFeatureGroups: ['brokerFlow'],
        profitRetention: 0.86,
        regime: 'bull',
        exitSource: 'eod_exit',
      },
    }),
    created_at: '2026-05-29T06:01:00Z',
  },
  {
    trade_date: '2026-05-30',
    symbol: '4938',
    event_type: 'holding_exit_outcome',
    detail_json: JSON.stringify({
      observation: {
        tradeDate: '2026-05-30',
        symbol: '4938',
        finalAction: 'partial_sell',
        baselineAction: 'hold',
        reward: -0.18,
        rewardBasis: 'absolute_return',
        realizedReturnPct: 0.02,
        exitShareRatio: 0.2,
        learningImpactWeight: 0.2,
        featureQualityCoverage: 0.5,
        flowEvidenceCoverage: 0.3333,
        missingFeatureGroups: ['brokerFlow', 'institutionalChip'],
        profitRetention: 0.35,
        regime: 'volatile',
        exitSource: 'intraday_tp1',
      },
    }),
    created_at: '2026-05-30T03:00:00Z',
  },
  {
    trade_date: '2026-05-31',
    symbol: '2330',
    event_type: 'holding_exit_outcome',
    status: 'observed',
    detail_json: JSON.stringify({
      observation: {
        tradeDate: '2026-05-31',
        symbol: '2330',
        finalAction: 'full_sell',
        activeDecisionSource: 'current_policy',
        learningEligible: false,
        baselineAction: 'full_sell',
        reward: 0.12,
        realizedReturnPct: 0.04,
        profitRetention: 0.62,
        regime: 'sideways',
        exitSource: 'eod_exit',
      },
    }),
    created_at: '2026-05-31T05:00:00Z',
  },
  {
    trade_date: '2026-05-31',
    symbol: '9999',
    event_type: 'holding_exit_outcome',
    status: 'failed',
    detail_json: JSON.stringify({
      observation: {
        tradeDate: '2026-05-31',
        symbol: '9999',
        finalAction: 'full_sell',
        baselineAction: 'hold',
        reward: 0.95,
        realizedReturnPct: 0.2,
        profitRetention: 1.1,
        regime: 'bull',
        exitSource: 'eod_exit',
      },
    }),
    created_at: '2026-05-31T06:00:00Z',
  },
  {
    trade_date: '2026-05-31',
    symbol: '2408',
    event_type: 'holding_exit_outcome',
    status: ' SKIPPED ',
    reason: 'stale_holding_exit_review',
    order_id: 77,
    detail_json: JSON.stringify({
      skip_reason: 'stale_holding_exit_review',
      exit_reason: 'trailing_stop',
      exit_source: 'eod_exit',
      entry_date: '2026-05-31',
      review_created_at: '2026-05-30T11:00:00Z',
    }),
    created_at: '2026-05-31T08:00:00Z',
  },
  {
    trade_date: '2026-05-31',
    symbol: '2408',
    event_type: 'holding_exit_outcome',
    status: ' SKIPPED ',
    reason: 'stale_holding_exit_review',
    order_id: 77,
    detail_json: JSON.stringify({
      skip_reason: 'stale_holding_exit_review',
      exit_reason: 'trailing_stop',
      exit_source: 'eod_exit',
      entry_date: '2026-05-31',
      review_created_at: '2026-05-30T11:00:00Z',
    }),
    created_at: '2026-05-31T08:01:00Z',
  },
]

const parsed = parseHoldingExitOutcomeEvent(events[0] as any)
assert(parsed?.symbol === '2408', 'parser should recover symbol from outcome event')
assert(parsed?.finalAction === 'move_tp2', 'parser should expose active final action')
assert(parsed?.baselineAction === 'full_sell', 'parser should expose baseline counterfactual action')
assert((parsed as any)?.activeVsBaselineReturnDeltaPct === 0.03, 'parser should expose active-vs-baseline return delta')
assert((parsed as any)?.rewardBasis === 'counterfactual_delta', 'parser should expose reward basis used by learning')
assert((parsed as any)?.counterfactualRewardScore === 0.25, 'parser should expose counterfactual reward score')
assert((parsed as any)?.baselineReturnPct === 0.08, 'parser should expose baseline return pct for recent outcome lineage')
assert((parsed as any)?.baselineExitPrice === 108, 'parser should expose baseline exit price for recent outcome lineage')
assert((parsed as any)?.exitShareRatio === 1, 'parser should expose sold share ratio for learning impact lineage')
assert((parsed as any)?.learningImpactWeight === 1, 'parser should expose adaptive learning impact weight')
assert((parsed as any)?.featureQualityCoverage === 0.67, 'parser should expose feature-quality coverage for Q guard lineage')
assert((parsed as any)?.flowEvidenceCoverage === 0.6667, 'parser should expose flow-evidence coverage for Q guard lineage')
assert((parsed as any)?.missingFeatureGroups.includes('brokerFlow'), 'parser should expose missing feature groups for Q guard lineage')
assert((parsed as any)?.orderId === 66, 'parser should expose order id for duplicate outcome analytics lineage')

const baselineParsed = parseHoldingExitOutcomeEvent(events.find((event) => event.symbol === '2330') as any)
assert((baselineParsed as any)?.activeDecisionSource === 'current_policy', 'parser should expose final decision source for learning attribution')
assert((baselineParsed as any)?.learningEligible === false, 'parser should expose whether an observed outcome updated adaptive params')

const report = buildHoldingExitOutcomeAnalytics(events as any, { days: 30 })

assert(report.schemaVersion === 'paper-holding-exit-outcome-analytics-v1', 'report schema should be explicit')
assert(report.totalOutcomes === 3, 'report should count all parsed outcomes')
assert(report.recent.length === 3, 'report should deduplicate repeated learned/observed outcomes for the same order id')
assert(!report.recent.some((row) => row.symbol === '9999'), 'report should exclude failed outcome audit rows from reward analytics')
assert((report as any).skippedOutcomeCount === 1, 'report should count skipped holding-exit outcome audit events separately')
assert((report as any).bySkipReason.stale_holding_exit_review.count === 1, 'report should group skipped outcomes by skip reason')
assert((report as any).recentSkipped[0].symbol === '2408', 'report should expose recent skipped outcome audits')
assert((report as any).recentSkipped[0].reviewCreatedAt === '2026-05-30T11:00:00Z', 'recent skipped audits should preserve stale review timestamp')
assert((report as any).recentSkipped.length === 1, 'report should deduplicate repeated skipped audits for the same order id and reason')
assert(report.changedActionCount === 2, 'report should count active decisions that differed from baseline')
assert(report.byAction.move_tp2.count === 1, 'report should group outcomes by active action')
assert((report.byAction.move_tp2 as any).avgActiveVsBaselineReturnDeltaPct === 0.03, 'action slice should average active-vs-baseline delta')
assert((report.changedVsBaseline.changed as any).avgActiveVsBaselineReturnDeltaPct === 0.03, 'changed-vs-baseline slice should average active-vs-baseline delta')
assert((report.summary as any).counterfactualRewardCount === 1, 'summary should count counterfactual reward samples')
assert((report.summary as any).absoluteRewardCount === 1, 'summary should count absolute-return reward samples')
assert((report.summary as any).unknownRewardCount === 1, 'summary should keep legacy unknown reward-basis samples explicit')
assert((report.summary as any).avgCounterfactualRewardScore === 0.25, 'summary should average counterfactual reward scores')
assert((report.summary as any).featureQualitySampleCount === 2, 'summary should count outcomes with Q coverage')
assert((report.summary as any).avgFeatureQualityCoverage === 0.585, 'summary should average feature-quality coverage')
assert((report.summary as any).avgFlowEvidenceCoverage === 0.5, 'summary should average flow-evidence coverage')
assert((report.summary as any).lowQualityOutcomeCount === 2, 'summary should count low-Q outcomes')
assert((report.summary as any).learningEligibleCount === 2, 'summary should count outcomes eligible for adaptive learning')
assert((report.summary as any).learningSkippedCount === 1, 'summary should count observed baseline outcomes skipped by learning')
assert((report.summary as any).avgExitShareRatio === 0.733333, 'summary should average sold share ratio')
assert((report.summary as any).avgLearningImpactWeight === 0.733333, 'summary should average adaptive learning impact weight')
assert((report as any).byRewardBasis.counterfactual_delta.count === 1, 'report should group outcomes by reward basis')
assert((report as any).byActiveDecisionSource.current_policy.count === 1, 'report should group outcomes by active decision source')
assert(report.byRegime.volatile.avgReward < 0, 'regime slices should retain reward direction')
assert(report.summary.avgProfitRetention > 0.6, 'summary should average profit retention')
assert(report.recent[0].symbol === '2330', 'recent outcomes should be newest first and exclude skipped audit rows')
assert((report.recent[2] as any).baselineExitPrice === 108, 'recent rows should retain baseline exit price for lineage')
assert((report.recent[2] as any).rewardBasis === 'counterfactual_delta', 'recent rows should retain reward basis for lineage')
assert((report.recent[1] as any).learningImpactWeight === 0.2, 'recent rows should retain learning impact weight')
assert((report.recent[2] as any).flowEvidenceCoverage === 0.6667, 'recent rows should retain flow evidence coverage for lineage')
