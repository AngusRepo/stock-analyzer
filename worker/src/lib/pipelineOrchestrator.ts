import type { Bindings } from '../types'
import { twToday } from './dateUtils'
import type { StrategyEvidenceMode } from './strategySpec'

export interface MarketScreenerRunOptions {
  evidenceMode?: StrategyEvidenceMode
  observedTaipeiDate?: string
}

export function resolveMarketScreenerEvidenceMode(
  runDate?: string | null,
  options: MarketScreenerRunOptions = {},
): { runDate: string; evidenceMode: StrategyEvidenceMode } {
  const observedTaipeiDate = String(options.observedTaipeiDate ?? twToday()).trim()
  const effectiveRunDate = String(runDate ?? '').trim() || observedTaipeiDate
  return {
    runDate: effectiveRunDate,
    evidenceMode: options.evidenceMode
      ?? (effectiveRunDate === observedTaipeiDate ? 'live_current' : 'historical_replay'),
  }
}

export async function runDailyRecommendation(env: Bindings, runDate?: string | null) {
  const { runMLAndRiskV2 } = await import('./mlPipelineTrigger')
  return runMLAndRiskV2(env, runDate ?? undefined)
}

export async function runMarketScreener(
  env: Bindings,
  runDate?: string | null,
  options: MarketScreenerRunOptions = {},
) {
  const { runBottomUpScreener } = await import('./marketScreener')
  const resolved = resolveMarketScreenerEvidenceMode(runDate, options)
  return runBottomUpScreener(env, resolved.runDate, { evidenceMode: resolved.evidenceMode })
}
