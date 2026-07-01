import { buildMarketDashboardMaterializationCheck } from './dataQualityMonitor'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const check = buildMarketDashboardMaterializationCheck({
    targetDate: '2026-06-26',
    sources: [
      {
        key: 'twoii_index',
        label: '櫃買指數',
        source: 'canonical_market_index_daily symbol=TWOII/OTC/TPEX',
        rows: 0,
        latestDate: null,
        warnLagDays: 1,
        failLagDays: 3,
      },
      {
        key: 'gdelt_global_news',
        label: 'GDELT 全球新聞脈絡',
        source: 'external_evidence_items source_id=gdelt_events',
        rows: 0,
        latestDate: null,
        warnLagDays: 7,
        failLagDays: 14,
        required: false,
        rootCause: 'formal_shadow_fetch_failed',
      },
      {
        key: 'business_signal',
        label: '景氣對策信號',
        source: 'canonical_regime_context_daily dataset=tw_business_indicators',
        rows: 1,
        latestDate: '2026-04-30',
        warnLagDays: 45,
        failLagDays: 60,
      },
    ],
  })

  const items = check.metrics?.materialization_checks as Array<Record<string, unknown>>
  assert(check.status === 'fail', 'missing required market data should fail the dashboard materialization check')
  assert(check.metrics?.missing_required instanceof Array, 'missing_required should be exposed for UI routing')
  assert((check.metrics.missing_required as string[]).includes('twoii_index'), 'TWOII gap must be explicitly named')
  assert(items.find((item) => item.key === 'gdelt_global_news')?.status === 'warn', 'optional GDELT gap should warn, not fail')
  assert(items.find((item) => item.key === 'gdelt_global_news')?.root_cause === 'formal_shadow_fetch_failed', 'GDELT root cause should pass through')
  assert(items.find((item) => item.key === 'business_signal')?.status === 'warn', 'monthly business signal should warn before it exceeds the hard fail window')
}

{
  const check = buildMarketDashboardMaterializationCheck({
    targetDate: '2026-06-30',
    sources: [
      {
        key: 'gdelt_global_news',
        label: 'GDELT ?函??啗??窗',
        source: 'external_evidence_items source_id=gdelt_events',
        rows: 1,
        latestDate: '2026-06-30',
        warnLagDays: 7,
        failLagDays: 14,
        required: false,
        rootCause: 'formal_shadow_fetch_failed',
      },
    ],
  })

  const item = (check.metrics?.materialization_checks as Array<Record<string, unknown>>)[0]
  assert(check.status === 'warn', 'optional GDELT status row with non-ok root cause should stay warn')
  assert(item?.status === 'warn', 'non-ok GDELT root cause should not render green when a status row exists')
}

{
  const check = buildMarketDashboardMaterializationCheck({
    targetDate: '2026-06-26',
    sources: [
      {
        key: 'twii_index',
        label: '加權指數',
        source: 'canonical_market_index_daily symbol=TWII/TAIEX',
        rows: 1,
        latestDate: '2026-06-26T12:00:00+08:00',
        warnLagDays: 0,
        failLagDays: 1,
      },
      {
        key: 'market_turnover',
        label: '成交量與成交金額',
        source: 'canonical_market_summary_daily total_volume/total_value',
        rows: 2,
        latestDate: '2026-06-25',
        warnLagDays: 0,
        failLagDays: 1,
      },
    ],
  })

  assert(check.status === 'warn', 'one-day-lag dashboard sources should no longer pass as green')
  const items = check.metrics?.materialization_checks as Array<Record<string, unknown>>
  assert(items.find((item) => item.key === 'market_turnover')?.status === 'warn', 'one-day-lag daily source should render as warning')
}

{
  const check = buildMarketDashboardMaterializationCheck({
    targetDate: '2026-07-01',
    sources: [
      {
        key: 'business_signal',
        label: '景氣對策信號',
        source: 'canonical_regime_context_daily dataset=tw_business_indicators',
        rows: 1,
        latestDate: '2026-04-27',
        warnLagDays: 45,
        failLagDays: 60,
      },
    ],
  })

  const items = check.metrics?.materialization_checks as Array<Record<string, unknown>>
  assert(check.status === 'fail', 'stale monthly business signal beyond 60 days should fail')
  assert(items.find((item) => item.key === 'business_signal')?.status === 'fail', '4/27 business signal on 7/1 must not be green')
}
