import {
  buildIntradayTechnicalSnapshot,
  floorRollingBarIntervalMs,
  resolveIntradayTechnicalDecision,
} from './intradayTechnicalSnapshot'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(floorRollingBarIntervalMs(10_000) === 30_000, '10s quote loop should floor technical bars to 30s')
  assert(floorRollingBarIntervalMs(60_000) === 60_000, '1m bar interval should be preserved')
}

{
  const snapshot = buildIntradayTechnicalSnapshot({
    symbol: '2330',
    previousClose: 100,
    previousAtr14: 2,
    previousObvTemperature60: 50,
    previousAdaptiveRsiUpper50: 70,
    rollingBars: [
      { startMs: 0, open: 100, high: 101, low: 99.5, close: 100.5, volume: 100 },
      { startMs: 30_000, open: 100.5, high: 102, low: 100.2, close: 101.5, volume: 120 },
      { startMs: 60_000, open: 101.5, high: 103, low: 101.1, close: 102.5, volume: 160 },
    ],
  })

  assert(snapshot.symbol === '2330', 'snapshot should preserve symbol')
  assert(snapshot.currentAtr14 > 2, 'intraday true range expansion should raise hybrid ATR')
  assert(snapshot.atrDefense === 100.5, 'ATR defense should trail from current close minus hybrid ATR')
  assert(snapshot.obvTemperature60 > 50, 'rising price with volume should warm OBV temperature')
  assert(snapshot.vwap > 101, 'rolling snapshot should compute VWAP from rolling bars')
  assert(snapshot.priceVsVwapPct != null && snapshot.priceVsVwapPct > 0, 'snapshot should expose price vs VWAP')
  assert(snapshot.rangePosition != null && snapshot.rangePosition > 0.8, 'snapshot should expose intraday range position')
  assert(snapshot.adaptiveRsiState === 'constructive', 'price above prior close but below adaptive upper band should be constructive')
  assert(snapshot.source === 'intraday_rolling_bar', 'snapshot should expose source')
}

{
  const snapshot = buildIntradayTechnicalSnapshot({
    symbol: '2344',
    previousClose: 155,
    previousAtr14: 10,
    previousObvTemperature60: 58,
    previousAdaptiveRsiUpper50: 70,
    sessionHigh: 156.5,
    sessionLow: 142.5,
    sessionTotalVolume: 322774,
    rollingBars: [
      { startMs: 0, open: 145.5, high: 146, low: 145.5, close: 145.5, volume: 1000 },
      { startMs: 30_000, open: 145.5, high: 145.5, low: 143, close: 143, volume: 1200 },
      { startMs: 60_000, open: 143, high: 143, low: 142.5, close: 142.5, volume: 1400 },
    ],
  })
  const decision = resolveIntradayTechnicalDecision({
    snapshot,
    strategyMode: 'pullback',
    marketRiskLevel: 'high',
    minRangePosition: 0.15,
    minDistributionSkipBarCount: 20,
  })
  assert(decision.action === 'defer', 'early technical distribution should stay pending during cooldown')
  assert(decision.reason === 'technical_distribution_cooldown', 'early distribution should explain cooldown instead of terminal skip')
}

{
  const snapshot = buildIntradayTechnicalSnapshot({
    symbol: '2344',
    previousClose: 155,
    previousAtr14: 10,
    previousObvTemperature60: 58,
    previousAdaptiveRsiUpper50: 70,
    sessionHigh: 156.5,
    sessionLow: 142.5,
    sessionTotalVolume: 322774,
    rollingBars: Array.from({ length: 24 }, (_, index) => ({
      startMs: index * 30_000,
      open: 145.5,
      high: 146,
      low: 142.5,
      close: 142.5,
      volume: 1200 + index,
    })),
  })
  const decision = resolveIntradayTechnicalDecision({
    snapshot,
    strategyMode: 'pullback',
    marketRiskLevel: 'high',
    minRangePosition: 0.15,
    minDistributionSkipBarCount: 20,
  })
  assert(decision.action === 'skip', 'weak RSI plus cold OBV near session low should become a real technical skip')
  assert(decision.reason === 'technical_distribution', 'technical skip should use a stable reason')
  assert(decision.detail.includes('obv_temp='), 'technical decision should expose OBV temperature')
  assert(decision.detail.includes('price_vwap_pct='), 'technical decision should expose VWAP reclaim state')
}
