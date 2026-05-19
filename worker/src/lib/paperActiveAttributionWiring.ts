import type { PaperDecisionAttributionInput } from './paperActiveChallenger'
import { recordPaperDecisionAttribution } from './paperActiveChallenger'
import type { PendingBuy } from './pendingBuyStore'
import type { Bindings } from '../types'

export interface PendingBuyPaperAttributionContext {
  tradeDate: string
  sourceRecoDate?: string | null
  paperLane?: string
  candidateSource?: string
  featureSetVersion?: string | null
  regimeVersion?: string | null
  evidenceSources?: string[]
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = finiteNumber(value)
    if (numeric != null) return numeric
  }
  return null
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

function buildEvidenceSources(item: PendingBuy, context: PendingBuyPaperAttributionContext): string[] {
  return dedupe([
    ...(context.evidenceSources ?? [
      'daily_recommendations',
      'predictions.ensemble',
      'pending_buy_orchestrator',
    ]),
    context.sourceRecoDate ? `source_reco_date:${context.sourceRecoDate}` : '',
    item.source ? `pending_source:${item.source}` : '',
  ])
}

export function buildPendingBuyPaperAttributionEvents(
  pendingBuys: PendingBuy[],
  context: PendingBuyPaperAttributionContext,
): PaperDecisionAttributionInput[] {
  return pendingBuys
    .filter((item) => typeof item.symbol === 'string' && item.symbol.trim().length > 0)
    .map((item) => {
      const verdict = item.debate_verdict || item.signal || 'unknown'
      return {
        tradeDate: context.tradeDate,
        symbol: item.symbol,
        decision: `pending_buy:${verdict}`,
        paperLane: context.paperLane ?? 'paper_active_baseline',
        candidateSource: context.candidateSource ?? 'morning_setup_pending_buy',
        baselineScore: firstFinite(item.score, item.ml_score, item.confidence),
        challengerScore: null,
        featureSetVersion: context.featureSetVersion ?? null,
        regimeVersion: context.regimeVersion ?? null,
        evidenceSources: buildEvidenceSources(item, context),
      }
    })
}

export async function recordPendingBuyPaperAttribution(
  env: Pick<Bindings, 'DB'>,
  pendingBuys: PendingBuy[],
  context: PendingBuyPaperAttributionContext,
): Promise<number> {
  const events = buildPendingBuyPaperAttributionEvents(pendingBuys, context)
  for (const event of events) {
    await recordPaperDecisionAttribution(env, event)
  }
  return events.length
}
