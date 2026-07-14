import type { StockVisionOrderIntent } from './stockvisionOrderIntent'

export interface PaperBrokerReconciliationInput {
  intent: StockVisionOrderIntent
  finlabPreview?: {
    status?: string | null
    visible_reason?: string | null
    can_submit_real_order?: boolean | null
  } | null
  simulatedFill: {
    fillable: boolean
    fillPrice?: number | null
    shares?: number | null
    reason?: string | null
  }
  l5?: {
    bestAsk?: number | null
    bestBid?: number | null
    spreadPct?: number | null
    orderBookImbalance?: number | null
  } | null
}

export interface PaperBrokerReconciliation {
  schemaVersion: 'paper-broker-reconciliation-v1'
  status: 'matched' | 'blocked_by_preview' | 'preview_missing' | 'simulation_not_fillable' | 'mismatch'
  liveSubmitEnabled: false
  symbol: string
  side: 'buy' | 'sell'
  previewStatus: string
  simulatedFillReason: string
  expectedSlippagePct: number | null
  mismatches: string[]
  detail: Record<string, unknown>
}

function roundMetric(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export function buildPaperBrokerReconciliation(input: PaperBrokerReconciliationInput): PaperBrokerReconciliation {
  const previewStatus = String(input.finlabPreview?.status ?? 'missing').toLowerCase()
  const fillReason = String(input.simulatedFill.reason ?? 'unknown')
  const mismatches: string[] = []
  if (input.finlabPreview?.can_submit_real_order === true) mismatches.push('preview_attempted_live_submit')
  if ((previewStatus === 'blocked' || previewStatus === 'error') && input.simulatedFill.fillable) {
    mismatches.push('preview_blocked_but_simulation_fillable')
  }
  if ((previewStatus === 'pass' || previewStatus === 'warning') && !input.simulatedFill.fillable) {
    mismatches.push('preview_passed_but_simulation_not_fillable')
  }
  const bestAsk = Number(input.l5?.bestAsk ?? input.intent.executionConstraints.bestAsk ?? 0)
  const bestBid = Number(input.l5?.bestBid ?? input.intent.executionConstraints.bestBid ?? 0)
  const fillPrice = Number(input.simulatedFill.fillPrice ?? 0)
  if (input.intent.side === 'buy' && input.simulatedFill.fillable && bestAsk > 0 && fillPrice > 0 && fillPrice < bestAsk) {
    mismatches.push('buy_fill_below_fresh_best_ask')
  }
  if (input.intent.side === 'sell' && input.simulatedFill.fillable && bestBid > 0 && fillPrice > 0 && fillPrice > bestBid) {
    mismatches.push('sell_fill_above_fresh_best_bid')
  }
  const benchmark = input.intent.side === 'buy' ? bestAsk : bestBid
  const expectedSlippagePct = benchmark > 0 && fillPrice > 0
    ? roundMetric(input.intent.side === 'buy' ? (fillPrice - benchmark) / benchmark : (benchmark - fillPrice) / benchmark)
    : null
  const status =
    previewStatus === 'missing' ? 'preview_missing'
      : (previewStatus === 'blocked' || previewStatus === 'error') ? 'blocked_by_preview'
        : !input.simulatedFill.fillable ? 'simulation_not_fillable'
          : mismatches.length > 0 ? 'mismatch'
            : 'matched'

  return {
    schemaVersion: 'paper-broker-reconciliation-v1',
    status,
    liveSubmitEnabled: false,
    symbol: input.intent.symbol,
    side: input.intent.side,
    previewStatus,
    simulatedFillReason: fillReason,
    expectedSlippagePct,
    mismatches,
    detail: {
      intent: input.intent,
      finlab_preview: input.finlabPreview ?? null,
      simulated_fill: input.simulatedFill,
      l5: input.l5 ?? null,
    },
  }
}
