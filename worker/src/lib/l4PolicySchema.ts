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
