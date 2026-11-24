import type { Bindings } from '../types'
import { recomputeDailyMarketRisk } from './marketRiskMaterialization'

export interface MaterializedMarketRisk {
  date: string
  owner: string
  quality_status: string
  known_score: number
  upper_score: number
  quality_checksum: string
  risk_config_unavailable?: boolean
}

/** Day-t quality is an HMM input, so it cannot wait for downstream pipeline dispatch.
 * Pipeline still refreshes the factor packet after the new HMM publication.
 */
export async function prepareIndicatorRegime(
  env: Bindings,
  date: string,
  compute: () => Promise<unknown>,
  materialize: (env: Bindings, date: string) => Promise<MaterializedMarketRisk> = recomputeDailyMarketRisk,
): Promise<string> {
  const risk = await materialize(env, date)
  if (risk.date !== date || risk.owner !== 'market-risk-quality-v1'
      || !['complete', 'bounded'].includes(risk.quality_status)
      || !Number.isFinite(risk.known_score) || risk.known_score < 0 || risk.known_score > 100
      || risk.known_score !== risk.upper_score || !risk.quality_checksum) {
    throw new Error(`same_date_regime_risk_not_qualified:${date}:${risk.quality_status}`)
  }
  const summary = String(await compute())
  // trading:risk_config unavailable: v1, the receipt and HMM still publish as on main, so the runtime keeps
  // de-risking existing positions while it blocks new risk (blocker risk_config_unavailable). The outage is
  // reported here and by the nightly kv-config-drift task, without stopping the downstream chain.
  if (risk.risk_config_unavailable === true) {
    console.warn(`[RiskConfig] trading:risk_config unavailable on ${date}: no stored v2, packet flagged`)
    return `${summary}; risk_config_unavailable`
  }
  return summary
}
