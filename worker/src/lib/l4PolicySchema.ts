// L4 policy shape contract shared by the config validator and its readers.
// Mirrors ml-controller services/l4_opb_selection.py (POLICY_SCHEMA, ALLOCATOR_KEYS).
export const L4_POLICY_V2 = 'l4-distribution-policy-v2'
export const L4_V2_ALLOCATOR_KEYS: ReadonlySet<string> = new Set(['alpha_strength', 'risk_aversion', 'turnover_penalty',
  'l2_penalty', 'max_cluster_weight', 'cluster_edge_threshold', 'cluster_threshold_quantile', 'sector_concentration_cap',
  'covariance_horizon_sessions', 'return_history_lookback_sessions', 'cost_objective'])
// Mirrors l4_opb_selection.COST_OBJECTIVES (single-side v1 objective, entry round trip).
export const L4_V2_COST_OBJECTIVES: ReadonlySet<string> = new Set(['single_side_v1', 'entry_round_trip_v1'])

export function isL4PolicyV2(policy: unknown): boolean {
  return (policy as { policy_schema?: unknown } | null | undefined)?.policy_schema === L4_POLICY_V2
}

// OPB v3 (mirrors l4_opb_selection.validate_v3_config / arm_definition_v3): arms
// override allocator selection parameters only; exposure and the single-name cap
// stay with risk. Every statistical knob is an explicit KV field (no code default).
export const L4_OPB_V2 = 'l4-opb-relative-arms-v2'
export const L4_OPB_V3 = 'l4-opb-selection-arms-v3'
export const L4_OPB_V3_REWARD = 'exposure_normalized_market_neutral_daily_v1'
const V3_KEYS = new Set(['schema_version', 'enabled', 'reward_window_observations', 'reward_half_life_observations',
  'arms', 'migration', 'approved_policy_identity', 'reward', 'family_error_rate', 'critical_value_simulations',
  'inert_counterfactual', 'cutover_warm_start', 'hac_lag_sessions', 'min_exposure_ratio', 'market_proxy'])
// opb.market_proxy (mirrors l4_opb_selection.MARKET_PROXY_PATTERN): a TW ETF code only,
// because the five-session label calendar stays on 0050.
// Optional; absent means the controller's schema default (l4_opb_selection.MARKET_PROXY_DEFAULT),
// which is not repeated here. Owner trading:config, never searched by Optuna.
export const L4_OPB_MARKET_PROXY_PATTERN = /^00[0-9]{2,4}$/
// Mirrors l4_opb_selection.MAX_SIMULATION_CELLS (simulations x arms x window).
const MAX_SIMULATION_CELLS = 60_000_000
const V3_ARM_RANGES: Record<string, 'non_negative' | 'unit'> = { risk_aversion: 'non_negative', l2_penalty: 'non_negative',
  max_cluster_weight: 'unit', sector_concentration_cap: 'unit', turnover_penalty: 'non_negative' }
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const int = (v: unknown, lo: number, hi: number) => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi

export function l4OpbV3Error(opb: any): string | null {
  if (!opb || typeof opb !== 'object' || Object.keys(opb).some(k => !V3_KEYS.has(k))) return 'unknown_field'
  if (typeof opb.enabled !== 'boolean') return 'enabled'
  if (!int(opb.reward_window_observations, 1, 10_000)) return 'reward_window_observations'
  if (!num(opb.reward_half_life_observations) || opb.reward_half_life_observations <= 0) return 'reward_half_life_observations'
  if (opb.reward !== L4_OPB_V3_REWARD) return 'reward'
  if ('market_proxy' in opb && (typeof opb.market_proxy !== 'string' || !L4_OPB_MARKET_PROXY_PATTERN.test(opb.market_proxy)))
    return 'market_proxy'
  if (!num(opb.family_error_rate) || opb.family_error_rate <= 0 || opb.family_error_rate > 0.5) return 'family_error_rate'
  if (!int(opb.hac_lag_sessions, 0, 10)) return 'hac_lag_sessions'
  if (!int(opb.critical_value_simulations, 1000, 200_000)) return 'critical_value_simulations'
  if (!num(opb.min_exposure_ratio) || opb.min_exposure_ratio <= 0 || opb.min_exposure_ratio > 1) return 'min_exposure_ratio'
  const inert = opb.inert_counterfactual
  const refs = ['reference_exposure_cap', 'reference_name_cap']
  if (!inert || typeof inert !== 'object' || Object.keys(inert).sort().join() !== ['enabled', ...refs].sort().join()
    || typeof inert.enabled !== 'boolean') return 'inert_counterfactual'
  if (inert.enabled ? refs.some(k => !num(inert[k]) || inert[k] <= 0 || inert[k] > 1)
      || inert.reference_name_cap > inert.reference_exposure_cap
    : refs.some(k => inert[k] !== null)) return 'inert_counterfactual'
  const warm = opb.cutover_warm_start
  if (!warm || typeof warm !== 'object' || Object.keys(warm).sort().join() !== 'enabled,max_observations'
    || typeof warm.enabled !== 'boolean' || !int(warm.max_observations, 0, opb.reward_window_observations))
    return 'cutover_warm_start'
  const arms = opb.arms
  if (!Array.isArray(arms) || arms[0]?.id !== 'base' || Object.keys(arms[0]).length !== 1) return 'arms'
  if (opb.critical_value_simulations * arms.length * opb.reward_window_observations > MAX_SIMULATION_CELLS)
    return 'critical_value_simulations'
  const ids = new Set<string>()
  const definitions = new Set<string>()
  for (const arm of arms) {
    if (!arm || typeof arm.id !== 'string' || !arm.id || ids.has(arm.id)) return 'arms'
    ids.add(arm.id)
    // Python validate_arms rejects two arms with one definition (base = no overrides).
    const definition = JSON.stringify(Object.keys(arm).filter(k => k !== 'id').sort().map(k => [k, arm[k]]))
    if (definitions.has(definition)) return 'arms'
    definitions.add(definition)
    for (const [key, value] of Object.entries(arm)) {
      if (key === 'id') continue
      const range = V3_ARM_RANGES[key]
      if (!range || !num(value) || value < 0 || (range === 'unit' && (value <= 0 || value > 1))) return 'arms'
    }
  }
  return null
}
