import { buildPaperBrokerReconciliation } from './paperBrokerReconciliation'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const reconciliation = buildPaperBrokerReconciliation({
    intent: {
      schemaVersion: 'stockvision-order-intent-v1',
      accountId: 1,
      tradeDate: '2026-05-28',
      symbol: '2330',
      side: 'buy',
      maxBudget: 100000,
      maxPrice: 100.5,
      minPrice: null,
      limitPrice: 100.5,
      priceRole: 'buy_max',
      priceTick: 0.5,
      priceSnapMode: 'floor_to_buy_limit',
      requestedShares: 995,
      orderLegs: [{ lotType: 'odd_lot', shares: 995, finlabQuantity: 995, finlabQuantityUnit: 'shares', oddLot: true, orderLot: 'intraday_odd' }],
      strategyType: 'pullback',
      timeInForce: 'ROD',
      liveSubmitRequested: false,
      riskContext: { marketRiskLevel: 'low', confidence: 0.74, riskPct: 0.01 },
      executionConstraints: { quoteSource: 'shioaji', quoteAgeMs: 800, maxEntryChasePct: 0.003 },
    },
    finlabPreview: {
      status: 'pass',
      visible_reason: 'broker preview passed',
      can_submit_real_order: false,
    },
    simulatedFill: {
      fillable: true,
      fillPrice: 100.4,
      shares: 995,
      reason: 'paper_order_created',
    },
    l5: {
      bestAsk: 100.5,
      bestBid: 100.3,
      spreadPct: 0.001994,
      orderBookImbalance: 0.2,
    },
  })

  assert(reconciliation.schemaVersion === 'paper-broker-reconciliation-v1', 'reconciliation schema should be stable')
  assert(reconciliation.status === 'matched', 'pass preview and fillable simulation should reconcile')
  assert(reconciliation.expectedSlippagePct < 0, 'fill below best ask should show non-positive slippage')
  assert(reconciliation.liveSubmitEnabled === false, 'reconciliation must keep live submit disabled')
}

{
  const reconciliation = buildPaperBrokerReconciliation({
    intent: {
      schemaVersion: 'stockvision-order-intent-v1',
      accountId: 1,
      tradeDate: '2026-05-28',
      symbol: '2330',
      side: 'buy',
      maxBudget: 100000,
      maxPrice: 100.5,
      minPrice: null,
      limitPrice: 100.5,
      priceRole: 'buy_max',
      priceTick: 0.5,
      priceSnapMode: 'floor_to_buy_limit',
      requestedShares: 995,
      orderLegs: [{ lotType: 'odd_lot', shares: 995, finlabQuantity: 995, finlabQuantityUnit: 'shares', oddLot: true, orderLot: 'intraday_odd' }],
      strategyType: 'breakout',
      timeInForce: 'ROD',
      liveSubmitRequested: false,
      riskContext: { marketRiskLevel: 'low', confidence: 0.74, riskPct: 0.01 },
      executionConstraints: { quoteSource: 'shioaji', quoteAgeMs: 800, maxEntryChasePct: 0.006 },
    },
    finlabPreview: {
      status: 'blocked',
      visible_reason: 'insufficient_settlement_cash',
      can_submit_real_order: false,
    },
    simulatedFill: {
      fillable: true,
      fillPrice: 100.4,
      shares: 995,
      reason: 'paper_order_created',
    },
  })

  assert(reconciliation.status === 'blocked_by_preview', 'blocked FinLab preview should fail reconciliation')
  assert(reconciliation.mismatches.includes('preview_blocked_but_simulation_fillable'), 'reconciliation should expose preview/fill mismatch')
}
