import type { Bindings } from '../types'
import { databaseForDataDomain } from '../lib/dataDomainRegistry'
import { historicalLearningLineageDecision } from '../lib/historicalLearningLineageGuard'

/**
 * live_current for today, or for a past date whose next session has not opened yet;
 * otherwise historical_replay. The next session comes from the market domain's
 * canonical_market_daily: the legacy DB copy stopped on 2026-08-21, so reading it
 * would leave the lineage write window open for any later date.
 */
export async function screenerEvidenceMode(
  env: Bindings,
  runDate: string,
  observedTaipeiDate: string,
  nowMs = Date.now(),
): Promise<'live_current' | 'historical_replay'> {
  if (runDate === observedTaipeiDate) return 'live_current'
  const boundary = await historicalLearningLineageDecision(
    databaseForDataDomain(env, 'market'), env.KV, 'screener-v2', runDate, nowMs)
  return boundary.allowed ? 'live_current' : 'historical_replay'
}
