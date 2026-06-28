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
        warnLagDays: 65,
        failLagDays: 95,
      },
    ],
  })

  const items = check.metrics?.materialization_checks as Array<Record<string, unknown>>
  assert(check.status === 'fail', 'missing required market data should fail the dashboard materialization check')
  assert(check.metrics?.missing_required instanceof Array, 'missing_required should be exposed for UI routing')
  assert((check.metrics.missing_required as string[]).includes('twoii_index'), 'TWOII gap must be explicitly named')
  assert(items.find((item) => item.key === 'gdelt_global_news')?.status === 'warn', 'optional GDELT gap should warn, not fail')
  assert(items.find((item) => item.key === 'gdelt_global_news')?.root_cause === 'formal_shadow_fetch_failed', 'GDELT root cause should pass through')
  assert(items.find((item) => item.key === 'business_signal')?.status === 'ok', 'monthly business signal should allow monthly lag window')
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
        warnLagDays: 1,
        failLagDays: 3,
      },
      {
        key: 'market_turnover',
        label: '成交量與成交金額',
        source: 'canonical_market_summary_daily total_volume/total_value',
        rows: 2,
        latestDate: '2026-06-25',
        warnLagDays: 1,
        failLagDays: 3,
      },
    ],
  })

  assert(check.status === 'ok', 'fresh and one-day-lag allowed dashboard sources should pass')
}
