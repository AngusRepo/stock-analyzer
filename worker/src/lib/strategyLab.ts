import {
  assessCandidateAgainstStrategySpecs,
  validateStrategySpec,
  type StrategyCandidateInput,
  type StrategySpec,
} from './strategySpec'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export interface StrategyLabDryRunResult {
  specId: string
  valid: boolean
  errors: string[]
  sampleSize: number
  matched: number
  matchRate: number
}

export function listStrategySpecs(specs: StrategySpec[]): StrategySpec[] {
  assertOwnerCanOwn('strategy', 'strategy_spec')
  return specs.map((spec) => ({ ...spec, riskNotes: [...spec.riskNotes], supportedRegimes: [...spec.supportedRegimes] }))
}

export function dryRunStrategySpec(
  spec: StrategySpec,
  candidates: StrategyCandidateInput[],
): StrategyLabDryRunResult {
  assertOwnerCanOwn('strategy', 'strategy_spec')
  const validation = validateStrategySpec(spec)
  const matched = validation.ok
    ? candidates.filter((candidate) => assessCandidateAgainstStrategySpecs(candidate, [spec]).matches.length > 0).length
    : 0
  const sampleSize = candidates.length
  return {
    specId: spec.id,
    valid: validation.ok,
    errors: validation.errors,
    sampleSize,
    matched,
    matchRate: sampleSize > 0 ? Math.round((matched / sampleSize) * 1000) / 1000 : 0,
  }
}
