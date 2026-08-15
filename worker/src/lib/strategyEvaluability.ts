import type { StrategySpec } from './strategySpec'

export const STRATEGY_EVALUABILITY_STATUSES = [
  'EVALUABLE',
  'NOT_APPLICABLE_PHASE',
  'NOT_APPLICABLE_OWNER',
  'PENDING_AVAILABILITY',
  'MISSING_SOURCE',
  'STALE_SOURCE',
  'SOURCE_ERROR',
  'INVALID_SPEC',
  'PIT_VIOLATION',
  'UNKNOWN_LEGACY',
] as const

export type StrategyEvaluabilityStatus = typeof STRATEGY_EVALUABILITY_STATUSES[number]
export type StrategyEvaluabilityDenominator = 'efficacy' | 'data_quality' | 'not_applicable'

export type StrategyEvaluabilityClassification = {
  status: StrategyEvaluabilityStatus
  evaluable: 0 | 1
  reason: string | null
  denominator: StrategyEvaluabilityDenominator
}

export const S12_FORMAL_INTRADAY_VARIANT = 's12_formal_intraday_snapshot'

export function isSelectionPhaseNotApplicable(spec: StrategySpec): boolean {
  return spec.variantId === S12_FORMAL_INTRADAY_VARIANT
    || spec.candidatePolicy?.evidenceRequirements?.includes('s12_structure_snapshots') === true
}

function statusForUnavailableReason(reason: string): StrategyEvaluabilityStatus {
  if (/pit|lookahead|knowledge_cutoff/i.test(reason)) return 'PIT_VIOLATION'
  if (/stale|expired/i.test(reason)) return 'STALE_SOURCE'
  if (/pending|not_yet_available/i.test(reason)) return 'PENDING_AVAILABILITY'
  if (/source_error|query_error|provider_error/i.test(reason)) return 'SOURCE_ERROR'
  if (/legacy|unverified/i.test(reason)) return 'UNKNOWN_LEGACY'
  return 'MISSING_SOURCE'
}

export function classifyStrategyEvaluability(input: {
  spec: StrategySpec
  specValid: boolean
  evaluable: boolean
  unavailableReasons?: readonly string[]
  invalidReasons?: readonly string[]
}): StrategyEvaluabilityClassification {
  if (!input.specValid) {
    const reason = [...(input.invalidReasons ?? [])].filter(Boolean).join('|') || 'strategy_spec_invalid'
    return { status: 'INVALID_SPEC', evaluable: 0, reason, denominator: 'data_quality' }
  }
  if (isSelectionPhaseNotApplicable(input.spec)) {
    return {
      status: 'NOT_APPLICABLE_OWNER',
      evaluable: 0,
      reason: 'selection_phase_owned_by_s12_execution_replay',
      denominator: 'not_applicable',
    }
  }
  if (input.evaluable) {
    return { status: 'EVALUABLE', evaluable: 1, reason: null, denominator: 'efficacy' }
  }
  const reason = [...(input.unavailableReasons ?? [])].filter(Boolean).join('|')
    || 'strategy_evaluability_missing'
  return {
    status: statusForUnavailableReason(reason),
    evaluable: 0,
    reason,
    denominator: 'data_quality',
  }
}

export function isNotApplicableStrategyEvaluability(status: unknown): boolean {
  return status === 'NOT_APPLICABLE_PHASE' || status === 'NOT_APPLICABLE_OWNER'
}
