import { DEFAULT_RISK_CONFIG, type RiskConfig } from './riskConfig'

/** A complete `trading:risk_config`. The single-name cap has no program default (K16a). */
export const RISK_CONFIG_FIXTURE: RiskConfig = {
  ...DEFAULT_RISK_CONFIG,
  position: { ...DEFAULT_RISK_CONFIG.position, maxSingleNamePct: 0.25 },
}
