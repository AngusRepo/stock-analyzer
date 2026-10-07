import type { Bindings } from '../types'
import { recomputeDailyMarketRisk } from './marketRiskMaterialization'

/** Day-t quality is an HMM input, so it cannot wait for downstream pipeline dispatch.
 * Pipeline still refreshes the factor packet after the new HMM publication.
 */
export async function prepareIndicatorRegime(
  env: Bindings,
  date: string,
  compute: () => Promise<unknown>,
  materialize: typeof recomputeDailyMarketRisk = recomputeDailyMarketRisk,
): Promise<string> {
  const risk = await materialize(env, date)
  if (risk.date !== date || risk.owner !== 'market-risk-quality-v1'
      || !['complete', 'bounded'].includes(risk.quality_status)
      || !Number.isFinite(risk.known_score) || risk.known_score < 0 || risk.known_score > 100
      || risk.known_score !== risk.upper_score || !risk.quality_checksum) {
    throw new Error(`same_date_regime_risk_not_qualified:${date}:${risk.quality_status}`)
  }
  return String(await compute())
}
