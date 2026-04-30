export type StrategyOwner =
  | 'screener'
  | 'strategy'
  | 'research'
  | 'recommendation'
  | 'model_lifecycle'
  | 'execution'
  | 'risk'
  | 'ui'

export type StrategyResponsibility =
  | 'candidate_discovery'
  | 'seed_scoring'
  | 'strategy_spec'
  | 'alpha_bucket_mapping'
  | 'research_hypothesis'
  | 'experiment_registry'
  | 'review_packet'
  | 'ml_prediction'
  | 'ml_ranking'
  | 'model_promote'
  | 'pending_buy'
  | 'broker_quote'
  | 'order_fill'
  | 'position_sizing'
  | 'dashboard_rendering'

export interface OwnerBoundary {
  owner: StrategyOwner
  owns: StrategyResponsibility[]
  forbidden: StrategyResponsibility[]
}

export const STRATEGY_OWNER_BOUNDARIES: OwnerBoundary[] = [
  {
    owner: 'screener',
    owns: ['candidate_discovery', 'seed_scoring'],
    forbidden: ['ml_prediction', 'ml_ranking', 'model_promote', 'pending_buy', 'broker_quote', 'order_fill'],
  },
  {
    owner: 'strategy',
    owns: ['strategy_spec', 'alpha_bucket_mapping'],
    forbidden: ['ml_prediction', 'model_promote', 'pending_buy', 'broker_quote', 'order_fill'],
  },
  {
    owner: 'research',
    owns: ['research_hypothesis', 'experiment_registry', 'review_packet'],
    forbidden: ['ml_prediction', 'ml_ranking', 'model_promote', 'pending_buy', 'broker_quote', 'order_fill'],
  },
  {
    owner: 'recommendation',
    owns: ['ml_prediction', 'ml_ranking'],
    forbidden: ['candidate_discovery', 'model_promote', 'broker_quote', 'order_fill'],
  },
  {
    owner: 'model_lifecycle',
    owns: ['model_promote'],
    forbidden: ['candidate_discovery', 'pending_buy', 'broker_quote', 'order_fill'],
  },
  {
    owner: 'execution',
    owns: ['pending_buy', 'broker_quote', 'order_fill'],
    forbidden: ['candidate_discovery', 'seed_scoring', 'strategy_spec', 'ml_prediction', 'model_promote'],
  },
  {
    owner: 'risk',
    owns: ['position_sizing'],
    forbidden: ['candidate_discovery', 'model_promote', 'broker_quote', 'order_fill'],
  },
  {
    owner: 'ui',
    owns: ['dashboard_rendering'],
    forbidden: ['candidate_discovery', 'seed_scoring', 'strategy_spec', 'ml_prediction', 'model_promote', 'order_fill'],
  },
]

export function findOwnerBoundary(owner: StrategyOwner): OwnerBoundary {
  const boundary = STRATEGY_OWNER_BOUNDARIES.find((b) => b.owner === owner)
  if (!boundary) throw new Error(`owner_boundary_missing:${owner}`)
  return boundary
}

export function assertOwnerCanOwn(owner: StrategyOwner, responsibility: StrategyResponsibility): void {
  const boundary = findOwnerBoundary(owner)
  if (boundary.forbidden.includes(responsibility)) {
    throw new Error(`owner_boundary_violation:${owner}:${responsibility}`)
  }
}

export function ownerOwns(owner: StrategyOwner, responsibility: StrategyResponsibility): boolean {
  return findOwnerBoundary(owner).owns.includes(responsibility)
}
