import { buildMarketOptimisticOutlook } from './marketOutlook'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const outlook = buildMarketOptimisticOutlook({
    marketRiskRow: {
      date: '2026-06-22',
      twii_close: 23000,
      twii_ma20: 22500,
      twii_bias: 2.22,
      twii_vol20: 18,
      foreign_net_5d: 150,
      bull_alignment_pct: 58,
      risk_level: 'green',
    },
    regimeState: { family: 'bull' },
    factorPacket: { level: 'green' },
  })
  assert(outlook.schema_version === 'market-outlook-v1', 'market outlook should expose a versioned contract')
  assert(outlook.optimistic_target != null && outlook.optimistic_target > 23000, 'bullish market outlook should estimate an upside target')
  assert(outlook.upside_pct != null && outlook.upside_pct > 3, 'bullish inputs should produce a meaningful optimistic upside estimate')
  assert(outlook.confidence === 'high', 'complete market inputs should produce high confidence')
  assert(outlook.target_basis === 'twii_20d_vol_regime_risk_chip_breadth_v1', 'target basis should be explicit and auditable')
  assert(outlook.summary.includes('TWII optimistic target'), 'summary should name the optimistic target')
}

{
  const outlook = buildMarketOptimisticOutlook({
    marketRiskRow: {
      date: '2026-06-22',
      twii_close: 23000,
      twii_ma20: 23800,
      twii_bias: -3.36,
      twii_vol20: 34,
      foreign_net_5d: -220,
      bull_alignment_pct: 18,
      risk_level: 'red',
    },
    regimeState: { family: 'bear' },
    factorPacket: { level: 'red' },
  })
  assert(outlook.optimistic_target != null && outlook.optimistic_target > 23000, 'even weak markets should still expose an optimistic reference target')
  assert(outlook.upside_pct != null && outlook.upside_pct <= 5, 'red risk should cap the optimistic upside estimate')
  assert(outlook.components.risk_scale === 0.5, 'red market risk should materially haircut the target')
}

{
  const outlook = buildMarketOptimisticOutlook({
    marketRiskRow: {
      date: '2026-06-22',
      twii_ma20: 22500,
      twii_vol20: 18,
      risk_level: 'yellow',
    },
    regimeState: { family: 'sideways' },
    factorPacket: { level: 'yellow' },
  })
  assert(outlook.optimistic_target == null, 'missing TWII close should fail closed for target price')
  assert(outlook.missing_reasons.includes('twii_close_missing'), 'missing base index price should be auditable')
  assert(outlook.confidence === 'low', 'missing base price should lower confidence')
}
