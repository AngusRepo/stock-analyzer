import {
  DEFAULT_STRATEGY_SPECS,
  type StrategySpec,
  type StrategySpecStatus,
} from './strategySpec'

export const STRATEGY_EVIDENCE_PROFILE_VERSION = 'strategy-specific-evidence-profile-v1'
export const CURRENT_CANONICAL_OUTCOME_HORIZON_DAYS = 5

export type StrategyEvidenceMetric =
  | 'residual_return_lcb90'
  | 'rank_ic'
  | 'max_drawdown'
  | 'turnover_after_cost'
  | 'regime_consistency'
  | 'false_breakout_rate'
  | 'tail_loss_cvar95'
  | 'time_to_reversion'
  | 'maximum_adverse_excursion'
  | 'downside_capture'
  | 'crowding_decay'
  | 'fundamental_revision_persistence'

export interface StrategyEvidenceProfile {
  schema_version: typeof STRATEGY_EVIDENCE_PROFILE_VERSION
  strategy_id: string
  strategy_version: string
  strategy_status: StrategySpecStatus
  primary_horizon_days: number
  evaluation_horizon_days: number[]
  available_outcome_horizon_days: number[]
  supported_regimes: string[]
  required_metrics: StrategyEvidenceMetric[]
  outcome_contract_status: 'fixed_5d_available' | 'primary_horizon_shadow_available' | 'multi_horizon_pending'
  outcome_source: 'canonical_selection_labels_v4.residual_return_net' | 'canonical_selection_outcomes_v1.residual_return_net'
  production_authority: 'comparison_only' | 'formal_owner_input_ready' | 'formal_owner_input_active'
}

type EvidencePlan = Pick<
  StrategyEvidenceProfile,
  'primary_horizon_days' | 'evaluation_horizon_days' | 'required_metrics'
>

const BUCKET_EVIDENCE_PLANS: Record<string, EvidencePlan> = {
  trend_following: {
    primary_horizon_days: 10,
    evaluation_horizon_days: [5, 10],
    required_metrics: ['residual_return_lcb90', 'rank_ic', 'max_drawdown', 'turnover_after_cost', 'regime_consistency'],
  },
  mean_reversion: {
    primary_horizon_days: 3,
    evaluation_horizon_days: [3, 5],
    required_metrics: ['residual_return_lcb90', 'time_to_reversion', 'maximum_adverse_excursion', 'tail_loss_cvar95', 'regime_consistency'],
  },
  breakout_vol_expansion: {
    primary_horizon_days: 5,
    evaluation_horizon_days: [3, 5],
    required_metrics: ['residual_return_lcb90', 'false_breakout_rate', 'tail_loss_cvar95', 'turnover_after_cost', 'regime_consistency'],
  },
  defensive_accumulation: {
    primary_horizon_days: 10,
    evaluation_horizon_days: [5, 10],
    required_metrics: ['residual_return_lcb90', 'downside_capture', 'max_drawdown', 'tail_loss_cvar95', 'crowding_decay'],
  },
  smart_money_accumulation: {
    primary_horizon_days: 10,
    evaluation_horizon_days: [5, 10],
    required_metrics: ['residual_return_lcb90', 'downside_capture', 'max_drawdown', 'tail_loss_cvar95', 'crowding_decay'],
  },
}

const STRATEGY_EVIDENCE_PLANS: Record<string, EvidencePlan> = {
  trend_following_seed_v1: {
    primary_horizon_days: 10,
    evaluation_horizon_days: [5, 10],
    required_metrics: [
      'residual_return_lcb90',
      'rank_ic',
      'max_drawdown',
      'turnover_after_cost',
      'regime_consistency',
    ],
  },
  breakout_vol_expansion_seed_v1: {
    primary_horizon_days: 5,
    evaluation_horizon_days: [3, 5],
    required_metrics: [
      'residual_return_lcb90',
      'false_breakout_rate',
      'tail_loss_cvar95',
      'turnover_after_cost',
      'regime_consistency',
    ],
  },
  alpha_miner_pymoo_nsga3_novelty_0081: {
    primary_horizon_days: 5,
    evaluation_horizon_days: [5, 10],
    required_metrics: [
      'residual_return_lcb90',
      'rank_ic',
      'max_drawdown',
      'turnover_after_cost',
      'regime_consistency',
    ],
  },
  defensive_accumulation_seed_v1: {
    primary_horizon_days: 10,
    evaluation_horizon_days: [5, 10],
    required_metrics: [
      'residual_return_lcb90',
      'downside_capture',
      'max_drawdown',
      'tail_loss_cvar95',
      'crowding_decay',
    ],
  },
  finlab_ai_skill_quality_trend_v1: {
    primary_horizon_days: 10,
    evaluation_horizon_days: [5, 10],
    required_metrics: [
      'residual_return_lcb90',
      'rank_ic',
      'fundamental_revision_persistence',
      'turnover_after_cost',
      'regime_consistency',
    ],
  },
  finlab_ai_skill_reversion_value_v1: {
    primary_horizon_days: 3,
    evaluation_horizon_days: [3, 5],
    required_metrics: [
      'residual_return_lcb90',
      'time_to_reversion',
      'maximum_adverse_excursion',
      'tail_loss_cvar95',
      'regime_consistency',
    ],
  },
  finlab_ai_skill_revenue_revision_breakout_v1: {
    primary_horizon_days: 5,
    evaluation_horizon_days: [3, 5],
    required_metrics: [
      'residual_return_lcb90',
      'false_breakout_rate',
      'fundamental_revision_persistence',
      'turnover_after_cost',
      'regime_consistency',
    ],
  },
  finlab_ai_skill_broker_accumulation_reclaim_v1: {
    primary_horizon_days: 10,
    evaluation_horizon_days: [5, 10],
    required_metrics: [
      'residual_return_lcb90',
      'downside_capture',
      'crowding_decay',
      'max_drawdown',
      'regime_consistency',
    ],
  },
  alphabuilders_multifactor_revenue_quality_momentum_v1: {
    primary_horizon_days: 10,
    evaluation_horizon_days: [5, 10],
    required_metrics: [
      'residual_return_lcb90',
      'rank_ic',
      'fundamental_revision_persistence',
      'max_drawdown',
      'regime_consistency',
    ],
  },
}

export function buildStrategyEvidenceProfile(
  spec: StrategySpec,
  options: { availableOutcomeHorizonDays?: number[] } = {},
): StrategyEvidenceProfile {
  const plan = STRATEGY_EVIDENCE_PLANS[spec.id] ?? BUCKET_EVIDENCE_PLANS[spec.alphaBucket]
  const availableOutcomeHorizonDays = [...new Set(
    options.availableOutcomeHorizonDays ?? [CURRENT_CANONICAL_OUTCOME_HORIZON_DAYS],
  )].filter((value) => [3, 5, 10].includes(value)).sort((left, right) => left - right)
  const primaryShadowAvailable = availableOutcomeHorizonDays.includes(plan.primary_horizon_days)
  const outcomeContractStatus: StrategyEvidenceProfile['outcome_contract_status'] =
    plan.primary_horizon_days === CURRENT_CANONICAL_OUTCOME_HORIZON_DAYS
      ? 'fixed_5d_available'
      : primaryShadowAvailable
        ? 'primary_horizon_shadow_available'
        : 'multi_horizon_pending'
  return {
    schema_version: STRATEGY_EVIDENCE_PROFILE_VERSION,
    strategy_id: spec.id,
    strategy_version: spec.version,
    strategy_status: spec.status,
    primary_horizon_days: plan.primary_horizon_days,
    evaluation_horizon_days: [...plan.evaluation_horizon_days],
    available_outcome_horizon_days: availableOutcomeHorizonDays,
    supported_regimes: [...spec.supportedRegimes],
    required_metrics: [...plan.required_metrics],
    outcome_contract_status: outcomeContractStatus,
    outcome_source: outcomeContractStatus === 'primary_horizon_shadow_available'
      ? 'canonical_selection_outcomes_v1.residual_return_net'
      : 'canonical_selection_labels_v4.residual_return_net',
    production_authority: 'comparison_only',
  }
}

export function listStrategyEvidenceProfiles(
  specs: StrategySpec[] = DEFAULT_STRATEGY_SPECS,
  options: { availableOutcomeHorizonDays?: number[] } = {},
): StrategyEvidenceProfile[] {
  return specs
    .filter((spec) => spec.status !== 'retired')
    .map((spec) => buildStrategyEvidenceProfile(spec, options))
}
