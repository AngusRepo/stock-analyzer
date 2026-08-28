export type ShadowPromotionMechanism =
  | 'strategy_v5'
  | 'active8_serving_bundle'
  | 'adaptive_meta_policy'
  | 'multi_horizon_evidence'
  | 'paper_kelly'
  | 's12_profit_continuation'
  | 'l4_alpha'
  | 'l4_plus_residual'
  | 'shadow_a'
  | 'state_space_overlay'
  | 'rfs_allocator'
  | 'execution_parity'

export type ShadowPromotionTarget =
  | 'strategy_policy'
  | 'ml_serving_bundle'
  | 'bounded_meta_policy'
  | 'decision_artifact'
  | 'paper_position_cap'
  | 'paper_exit_policy'
  | 'allocator_artifact'
  | 'none'

export type ShadowPromotionGovernance = {
  mechanism: ShadowPromotionMechanism
  target: ShadowPromotionTarget
  mode: 'automatic_evidence_gated' | 'comparison_only' | 'manual_only'
  canAutoPromote: boolean
  realOrderEffect: false
  realtimeMutation: false
  rollbackRequired: boolean
}

export const SHADOW_PROMOTION_GOVERNANCE: Readonly<Record<ShadowPromotionMechanism, ShadowPromotionGovernance>> = {
  strategy_v5: {
    mechanism: 'strategy_v5', target: 'strategy_policy', mode: 'automatic_evidence_gated',
    canAutoPromote: true, realOrderEffect: false, realtimeMutation: false, rollbackRequired: true,
  },
  active8_serving_bundle: {
    mechanism: 'active8_serving_bundle', target: 'ml_serving_bundle', mode: 'automatic_evidence_gated',
    canAutoPromote: true, realOrderEffect: false, realtimeMutation: false, rollbackRequired: true,
  },
  adaptive_meta_policy: {
    mechanism: 'adaptive_meta_policy', target: 'bounded_meta_policy', mode: 'automatic_evidence_gated',
    canAutoPromote: true, realOrderEffect: false, realtimeMutation: false, rollbackRequired: true,
  },
  multi_horizon_evidence: {
    mechanism: 'multi_horizon_evidence', target: 'decision_artifact', mode: 'automatic_evidence_gated',
    canAutoPromote: true, realOrderEffect: false, realtimeMutation: false, rollbackRequired: true,
  },
  paper_kelly: {
    mechanism: 'paper_kelly', target: 'paper_position_cap', mode: 'automatic_evidence_gated',
    canAutoPromote: true, realOrderEffect: false, realtimeMutation: false, rollbackRequired: true,
  },
  s12_profit_continuation: {
    mechanism: 's12_profit_continuation', target: 'paper_exit_policy', mode: 'automatic_evidence_gated',
    canAutoPromote: true, realOrderEffect: false, realtimeMutation: false, rollbackRequired: true,
  },
  l4_alpha: {
    mechanism: 'l4_alpha', target: 'allocator_artifact', mode: 'automatic_evidence_gated',
    canAutoPromote: true, realOrderEffect: false, realtimeMutation: false, rollbackRequired: true,
  },
  l4_plus_residual: {
    mechanism: 'l4_plus_residual', target: 'allocator_artifact', mode: 'automatic_evidence_gated',
    canAutoPromote: true, realOrderEffect: false, realtimeMutation: false, rollbackRequired: true,
  },
  shadow_a: {
    mechanism: 'shadow_a', target: 'none', mode: 'comparison_only',
    canAutoPromote: false, realOrderEffect: false, realtimeMutation: false, rollbackRequired: false,
  },
  state_space_overlay: {
    mechanism: 'state_space_overlay', target: 'none', mode: 'comparison_only',
    canAutoPromote: false, realOrderEffect: false, realtimeMutation: false, rollbackRequired: false,
  },
  rfs_allocator: {
    mechanism: 'rfs_allocator', target: 'none', mode: 'comparison_only',
    canAutoPromote: false, realOrderEffect: false, realtimeMutation: false, rollbackRequired: false,
  },
  execution_parity: {
    mechanism: 'execution_parity', target: 'none', mode: 'manual_only',
    canAutoPromote: false, realOrderEffect: false, realtimeMutation: false, rollbackRequired: false,
  },
}

export function assertAutomaticPromotionAllowed(
  mechanism: ShadowPromotionMechanism,
  target: Exclude<ShadowPromotionTarget, 'none'>,
): void {
  const policy = SHADOW_PROMOTION_GOVERNANCE[mechanism]
  if (!policy.canAutoPromote || policy.mode !== 'automatic_evidence_gated' || policy.target !== target) {
    throw new Error(`shadow_automatic_promotion_not_allowed:${mechanism}:${target}`)
  }
  if (policy.realOrderEffect !== false || policy.realtimeMutation !== false || !policy.rollbackRequired) {
    throw new Error(`shadow_automatic_promotion_safety_contract_invalid:${mechanism}`)
  }
}
