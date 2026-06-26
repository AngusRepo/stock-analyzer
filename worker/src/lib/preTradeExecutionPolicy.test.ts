import { evaluatePreTradeExecution } from './preTradeExecutionPolicy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function baseInput(overrides: Partial<Parameters<typeof evaluatePreTradeExecution>[0]> = {}) {
  return {
    symbol: '2330',
    currentPrice: 100,
    entryPrice: 100,
    stopLoss: 92,
    originalEntry: 100,
    retryCount: 0,
    previousClose: 98,
    quoteSource: 'shioaji' as const,
    marketRiskLevel: 'low',
    momentum: {
      volumeRatio: 1.2,
      minVolumeRatio: 0.8,
      slope5min: 0.01,
      rangePosition: 0.5,
      minRangePosition: 0.3,
    },
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
    },
    ...overrides,
  }
}

{
  const decision = evaluatePreTradeExecution(baseInput({ marketRiskLevel: 'unknown' }))
  assert(decision.action === 'DEFER', 'unknown market risk must fail closed')
}

{
  const decision = evaluatePreTradeExecution(baseInput({ marketRiskLevel: 'high' }))
  assert(decision.action === 'REQUOTE', 'high market risk should requote instead of buying')
  assert(decision.nextEntryPrice === 98.5, 'requote should lower entry by configured discount')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    marketRiskLevel: 'high',
    technical: {
      action: 'skip',
      reason: 'technical_distribution',
      detail: 'adaptive_rsi=weak;obv_temp=34;range_position=0',
    },
  }))
  assert(decision.action === 'SKIP', 'dynamic technical distribution should stop before generic risk requote')
  assert(decision.reason === 'technical_distribution', 'technical gate should own the visible skip reason')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    technical: {
      action: 'defer',
      reason: 'weak_no_reclaim',
      detail: 'adaptive_rsi=weak;price_vwap_pct=-0.004',
    },
  }))
  assert(decision.action === 'DEFER', 'weak intraday technicals should defer even when legacy momentum is clean')
  assert(decision.detail?.includes('price_vwap_pct'), 'technical defer should expose the actual snapshot fields')
}

{
  const decision = evaluatePreTradeExecution(baseInput({ momentum: { error: 'trend unavailable' } }))
  assert(decision.action === 'DEFER', 'momentum errors must not proceed with buy')
}

{
  const decision = evaluatePreTradeExecution(baseInput({ quoteSource: 'yahoo' }))
  assert(decision.action === 'DEFER', 'yahoo fallback quotes must not trigger buy')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    quoteAgeMs: 20_000,
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxQuoteAgeMs: 10_000,
    },
  }))
  assert(decision.action === 'DEFER', 'stale broker quotes must fail closed')
  assert(decision.reason === 'stale_quote:20s', 'stale quote reason should be readable')
}

{
  const decision = evaluatePreTradeExecution(baseInput({ currentPrice: 109.6, previousClose: 100 }))
  assert(decision.action === 'SKIP', 'limit-up chase must be skipped')
}

{
  const decision = evaluatePreTradeExecution(baseInput())
  assert(decision.action === 'BUY_AT', 'clean pre-trade context should allow buy')
  assert(decision.limitPrice === 100, 'buy limit should remain at entry price')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 100.4,
    bestAsk: 100.5,
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxEntryChasePct: 0.006,
    },
  }))
  assert(decision.action === 'BUY_AT', 'confirmed strong momentum should allow a bounded entry chase')
  assert(decision.limitPrice === 100.5, 'entry chase should use the executable best ask as the limit')
  assert(decision.reason === 'entry_chase_confirmed:0.50%', 'entry chase reason should expose the premium')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    momentum: {
      volumeRatio: 1.2,
      minVolumeRatio: 0.8,
      slope5min: 0.01,
      rangePosition: 0.2,
      minRangePosition: 0.3,
    },
  }))
  assert(decision.action === 'DEFER', 'low intraday range position must defer entry')
  assert(decision.reason === 'range_position_low', 'range-position gate should use a stable reason key')
  assert(decision.detail?.includes('range_position=0.2'), 'range-position gate should expose the observed value')
  assert(decision.detail?.includes('min=0.3'), 'range-position gate should expose the threshold')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 100.8,
    bestAsk: 100.9,
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxEntryChasePct: 0.006,
    },
  }))
  assert(decision.action === 'DEFER', 'entry chase must stay bounded instead of chasing extended prices')
  assert(decision.reason === 'price_above_entry', 'extended prices should keep the existing wait-for-pullback behavior')
  assert(decision.detail?.includes('premium=0.009'), 'price-above-entry gate should expose the chase premium')
  assert(decision.detail?.includes('max=0.006'), 'price-above-entry gate should expose the chase limit')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 101.1,
    bestAsk: 101.2,
    momentum: {
      volumeRatio: 1.8,
      minVolumeRatio: 0.8,
      strongBreakoutVolumeRatio: 1.5,
      slope5min: 0.02,
      rangePosition: 0.86,
      minRangePosition: 0.3,
      strongBreakoutRangePosition: 0.7,
    },
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxEntryChasePct: 0.006,
      strongBreakoutMaxEntryChasePct: 0.018,
    },
  }))
  assert(decision.action === 'BUY_AT', 'confirmed strong breakout should allow a wider bounded chase')
  assert(decision.limitPrice === 101.2, 'strong breakout chase should still use executable best ask')
  assert(decision.reason === 'strong_breakout_chase_confirmed:1.20%', 'strong breakout chase reason should expose the premium')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 101.1,
    bestAsk: 101.2,
    momentum: {
      volumeRatio: 1.1,
      minVolumeRatio: 0.8,
      strongBreakoutVolumeRatio: 1.5,
      slope5min: 0.02,
      rangePosition: 0.86,
      minRangePosition: 0.3,
      strongBreakoutRangePosition: 0.7,
    },
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxEntryChasePct: 0.006,
      strongBreakoutMaxEntryChasePct: 0.018,
    },
  }))
  assert(decision.action === 'DEFER', 'wide chase must not be allowed without strong volume confirmation')
  assert(decision.reason === 'price_above_entry', 'missing strong volume should keep wait-for-pullback behavior')
  assert(decision.detail?.includes('max=0.006'), 'non-breakout chase should keep the normal chase cap')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 99.2,
    entryPrice: 100,
    tradePlan: {
      source: 'ohlcv',
      mode: 'breakout',
      confirmation: 100,
      resistance: 103,
      support: 96,
      atrDefense: 95.5,
      volumeNode: 97.5,
      buyReferenceLow: 96,
      buyReferenceHigh: 97.5,
      optimisticLow: 100,
      optimisticHigh: 103,
    },
  }))
  assert(decision.action === 'DEFER', 'breakout mode must wait for OHLCV confirmation before buying below trigger')
  assert(decision.reason === 'waiting_for_ohlcv_confirmation', 'breakout trigger gate should use a stable reason key')
  assert(decision.detail?.includes('confirmation=100'), 'confirmation gate should expose the OHLCV trigger')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 104.2,
    bestAsk: 104.2,
    entryPrice: 100,
    momentum: {
      volumeRatio: 2,
      minVolumeRatio: 0.8,
      strongBreakoutVolumeRatio: 1.5,
      slope5min: 0.03,
      rangePosition: 0.92,
      minRangePosition: 0.3,
      strongBreakoutRangePosition: 0.7,
    },
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxEntryChasePct: 0.006,
      strongBreakoutMaxEntryChasePct: 0.018,
    },
    tradePlan: {
      source: 'ohlcv',
      mode: 'breakout',
      confirmation: 100,
      resistance: 103,
      support: 96,
      atrDefense: 95.5,
      volumeNode: 97.5,
      buyReferenceLow: 96,
      buyReferenceHigh: 97.5,
      optimisticLow: 100,
      optimisticHigh: 103,
    },
    entryModelV2: {
      modelVersion: 'entry_price_model_v2',
      anchorSource: 'daily_proxy_fallback',
      poc: 97.5,
      vah: null,
      val: null,
      discountLow: 96,
      discountHigh: 100,
      equilibrium: 100,
      premiumLow: 100,
      premiumHigh: 103,
      orderBlockLow: null,
      orderBlockHigh: null,
      fvgLow: null,
      fvgHigh: null,
      smcBias: 'neutral',
      smcScore: 0,
      smcBullishScore: 0,
      smcBearishScore: 0,
      liquiditySweepLow: null,
      structureBreakHigh: null,
      chochLevel: null,
      displacementPct: null,
      retestStatus: 'none',
      entryLow: 96,
      entryHigh: 100,
      preferredEntry: 100,
      chaseCeiling: 103,
      stopAnchor: 95.5,
      l5Support: { quoteAgeMs: null, spreadPct: null, depthOk: false, imbalance: null },
      confidence: 0.45,
      fallbackReason: 'ohlcv_trade_plan_proxy',
    },
  }))
  assert(decision.action === 'DEFER', 'backend must not chase above the v2 chase ceiling')
  assert(decision.reason === 'price_above_chase_ceiling', 'v2 gate should use chase ceiling semantics')
  assert(decision.detail?.includes('chase_ceiling=103'), 'v2 gate should expose the chase ceiling')
  assert(decision.detail?.includes('anchor_source=daily_proxy_fallback'), 'v2 gate should expose the anchor source')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 100.8,
    bestAsk: 100.8,
    entryPrice: 100,
    momentum: {
      error: 'trend_http_404',
    },
    tradePlan: {
      source: 'ohlcv',
      mode: 'pullback',
      confirmation: 103,
      resistance: 102.5,
      support: 96,
      atrDefense: 95.5,
      volumeNode: 98,
      buyReferenceLow: 98,
      buyReferenceHigh: 100,
      optimisticLow: 103,
      optimisticHigh: 104,
    },
  }))
  assert(decision.action === 'DEFER', 'without opening fast path, missing trend data should still defer')
  assert(decision.reason === 'momentum_unavailable:trend_http_404', 'trend error should remain visible')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 100.8,
    bestAsk: 100.8,
    entryPrice: 100,
    momentum: {
      error: 'trend_http_404',
    },
    openingFastPath: {
      enabled: true,
      minutesSinceOpen: 4,
      maxMinutes: 10,
      allowTrendUnavailable: true,
      maxPremiumPct: 0.012,
      l5Status: 'pass',
    },
    tradePlan: {
      source: 'ohlcv',
      mode: 'pullback',
      confirmation: 103,
      resistance: 102.5,
      support: 96,
      atrDefense: 95.5,
      volumeNode: 98,
      buyReferenceLow: 98,
      buyReferenceHigh: 100,
      optimisticLow: 103,
      optimisticHigh: 104,
    },
  }))
  assert(decision.action === 'BUY_AT', 'opening fast path should allow bounded early quote entry when trend is not ready')
  assert(decision.reason === 'opening_fast_path_entry:0.80%', 'opening fast path should expose the bounded premium')
  assert(decision.limitPrice === 100.8, 'opening fast path should use executable best ask as limit')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 104.5,
    bestAsk: 104.5,
    entryPrice: 100,
    momentum: {
      error: 'trend_http_404',
    },
    openingFastPath: {
      enabled: true,
      minutesSinceOpen: 4,
      maxMinutes: 10,
      allowTrendUnavailable: true,
      maxPremiumPct: 0.012,
      l5Status: 'pass',
    },
    tradePlan: {
      source: 'ohlcv',
      mode: 'pullback',
      confirmation: 103,
      resistance: 102.5,
      support: 96,
      atrDefense: 95.5,
      volumeNode: 98,
      buyReferenceLow: 98,
      buyReferenceHigh: 100,
      optimisticLow: 103,
      optimisticHigh: 104,
    },
    entryModelV2: {
      modelVersion: 'entry_price_model_v2',
      anchorSource: 'daily_proxy_fallback',
      poc: 98,
      vah: null,
      val: null,
      discountLow: 96,
      discountHigh: 100,
      equilibrium: 100,
      premiumLow: 100,
      premiumHigh: 104,
      orderBlockLow: null,
      orderBlockHigh: null,
      fvgLow: null,
      fvgHigh: null,
      smcBias: 'neutral',
      smcScore: 0,
      smcBullishScore: 0,
      smcBearishScore: 0,
      liquiditySweepLow: null,
      structureBreakHigh: null,
      chochLevel: null,
      displacementPct: null,
      retestStatus: 'none',
      entryLow: 98,
      entryHigh: 100,
      preferredEntry: 100,
      chaseCeiling: 104,
      stopAnchor: 95.5,
      l5Support: { quoteAgeMs: null, spreadPct: null, depthOk: true, imbalance: 0.1 },
      confidence: 0.45,
      fallbackReason: 'ohlcv_trade_plan_proxy',
    },
  }))
  assert(decision.action === 'DEFER', 'opening fast path must not override the v2 chase ceiling')
  assert(decision.reason === 'price_above_chase_ceiling', 'over-ceiling early quote should stay deferred')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 104.2,
    bestAsk: 104.2,
    entryPrice: 103,
    momentum: {
      volumeRatio: 1.15,
      minVolumeRatio: 1.0,
      strongBreakoutVolumeRatio: 1.3,
      slope5min: 0.01,
      rangePosition: 0.5,
      minRangePosition: 0.35,
      strongBreakoutRangePosition: 0.6,
    },
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxEntryChasePct: 0.012,
      strongBreakoutMaxEntryChasePct: 0.02,
    },
    tradePlan: {
      source: 'ohlcv',
      mode: 'breakout_continuation',
      confirmation: 100,
      resistance: 103,
      support: 96,
      atrDefense: 95.5,
      volumeNode: 97.5,
      buyReferenceLow: 96,
      buyReferenceHigh: 97.5,
      optimisticLow: 100,
      optimisticHigh: 103,
    },
  }))
  assert(decision.action === 'BUY_AT', 'breakout continuation should be governed by bounded chase, not preempted by optimistic range')
  assert(decision.reason === 'entry_chase_confirmed:1.17%', 'breakout continuation should expose the bounded chase premium')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 95.7,
    entryPrice: 97.5,
    tradePlan: {
      source: 'ohlcv',
      mode: 'pullback',
      confirmation: 100,
      resistance: 103,
      support: 96,
      atrDefense: 95.5,
      volumeNode: 97.5,
      buyReferenceLow: 96,
      buyReferenceHigh: 97.5,
      optimisticLow: 100,
      optimisticHigh: 103,
    },
  }))
  assert(decision.action === 'DEFER', 'backend must avoid buying after OHLCV support is lost')
  assert(decision.reason === 'ohlcv_support_lost', 'support-loss gate should use a stable reason key')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    currentPrice: 100.4,
    bestAsk: 100.5,
    entryPrice: 100,
    openingFastPath: {
      enabled: true,
      minutesSinceOpen: 4,
      maxMinutes: 10,
      allowTrendUnavailable: true,
      maxPremiumPct: 0.012,
      l5Status: 'pass',
    },
    entryModelV2: {
      modelVersion: 'entry_price_model_v2',
      anchorSource: 'intraday_volume_profile',
      poc: 100,
      vah: 100.8,
      val: 99.8,
      discountLow: 98,
      discountHigh: 100,
      equilibrium: 100,
      premiumLow: 100,
      premiumHigh: 103,
      orderBlockLow: null,
      orderBlockHigh: null,
      fvgLow: null,
      fvgHigh: null,
      smcBias: 'bearish',
      smcScore: -0.24,
      smcBullishScore: 0.02,
      smcBearishScore: 0.26,
      liquiditySweepLow: null,
      structureBreakHigh: null,
      chochLevel: null,
      displacementPct: null,
      retestStatus: 'none',
      entryLow: 99.8,
      entryHigh: 100,
      preferredEntry: 100,
      chaseCeiling: 100.8,
      stopAnchor: 96,
      l5Support: { quoteAgeMs: null, spreadPct: null, depthOk: false, imbalance: null },
      confidence: 0.65,
    },
  }))
  assert(decision.action === 'DEFER', 'bearish SMC structure must block opening fast-path catch-the-knife entries')
  assert(decision.reason === 'smc_bearish_structure', 'SMC structure should own the visible defer reason')
}

{
  const oldV2Blocked = evaluatePreTradeExecution(baseInput({
    currentPrice: 101.1,
    bestAsk: 101.1,
    entryPrice: 100,
    momentum: {
      volumeRatio: 1.2,
      minVolumeRatio: 0.8,
      slope5min: 0.01,
      rangePosition: 0.58,
      minRangePosition: 0.3,
    },
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxEntryChasePct: 0.012,
    },
    tradePlan: {
      source: 'ohlcv',
      mode: 'pullback',
      confirmation: 100,
      resistance: 101.25,
      support: 98.7,
      atrDefense: 98.7,
      volumeNode: 100,
      buyReferenceLow: 99.2,
      buyReferenceHigh: 100,
      optimisticLow: 100,
      optimisticHigh: 101.25,
    },
    entryModelV2: {
      modelVersion: 'entry_price_model_v2',
      anchorSource: 'daily_proxy_fallback',
      poc: 100,
      vah: null,
      val: null,
      discountLow: 98.7,
      discountHigh: 100,
      equilibrium: 100,
      premiumLow: 100,
      premiumHigh: 101.25,
      orderBlockLow: null,
      orderBlockHigh: null,
      fvgLow: null,
      fvgHigh: null,
      smcBias: 'neutral',
      smcScore: 0,
      smcBullishScore: 0,
      smcBearishScore: 0,
      liquiditySweepLow: null,
      structureBreakHigh: null,
      chochLevel: null,
      displacementPct: null,
      retestStatus: 'none',
      entryLow: 98.7,
      entryHigh: 100,
      preferredEntry: 100,
      chaseCeiling: 100.8,
      stopAnchor: 98.7,
      l5Support: { quoteAgeMs: null, spreadPct: null, depthOk: true, imbalance: 0.1 },
      confidence: 0.55,
      fallbackReason: 'ohlcv_trade_plan_proxy',
    },
  }))
  assert(oldV2Blocked.action === 'DEFER', 'old entry model should still block prices above its stale chase ceiling')
  assert(oldV2Blocked.reason === 'price_above_chase_ceiling', 'old v2 block should remain explicit')

  const s12Assisted = evaluatePreTradeExecution(baseInput({
    currentPrice: 101.1,
    bestAsk: 101.1,
    entryPrice: 100,
    momentum: {
      volumeRatio: 1.2,
      minVolumeRatio: 0.8,
      slope5min: 0.01,
      rangePosition: 0.58,
      minRangePosition: 0.3,
    },
    technical: {
      action: 'pass',
      reason: 's12_reaction_ready',
      detail: 'state=reaction_ready;entry=100;chase_ceiling=101.25;stop=98.7',
    },
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxEntryChasePct: 0.012,
    },
    tradePlan: {
      source: 'ohlcv',
      mode: 'pullback',
      confirmation: 100,
      resistance: 101.25,
      support: 98.7,
      atrDefense: 98.7,
      volumeNode: 100,
      buyReferenceLow: 100,
      buyReferenceHigh: 100,
      optimisticLow: 100,
      optimisticHigh: 101.25,
    },
    entryModelV2: null,
  }))
  assert(s12Assisted.action === 'BUY_AT', 'S12 assist-entry overlay should allow a bounded long entry inside its chase ceiling')
  assert(s12Assisted.reason === 'entry_chase_confirmed:1.10%', 'S12 assisted entry should expose the bounded chase premium')
  assert(s12Assisted.limitPrice === 101.1, 'S12 assisted entry should use executable best ask as limit')
}
