import { DEFAULT_RISK_CONFIG, type RiskConfig } from './riskConfig'

/** A complete `trading:risk_config`. The KV-owned position fields have no program default (K16a, C28-01). */
export const RISK_CONFIG_FIXTURE: RiskConfig = {
  ...DEFAULT_RISK_CONFIG,
  position: { ...DEFAULT_RISK_CONFIG.position, maxSingleNamePct: 0.25, minCorrelationOverlap: 20 },
}
