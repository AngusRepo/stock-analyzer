import {
  assessCandidateAgainstStrategySpecs,
  type StrategyCandidateInput,
  type StrategySpec,
  type StrategySpecAssessment,
} from './strategySpec'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export interface StrategyAnnotatedCandidate extends StrategyCandidateInput {
  strategy_matches?: StrategySpecAssessment['matches']
  strategy_tags?: string[]
  strategy_watch_points?: string[]
}

export function annotateCandidateWithStrategySpecs<T extends StrategyCandidateInput>(
  candidate: T,
  specs: StrategySpec[],
): T & StrategyAnnotatedCandidate {
  assertOwnerCanOwn('screener', 'candidate_discovery')
  assertOwnerCanOwn('strategy', 'strategy_spec')
  const assessment = assessCandidateAgainstStrategySpecs(candidate, specs)
  return {
    ...candidate,
    strategy_matches: [
      ...((candidate as StrategyAnnotatedCandidate).strategy_matches ?? []),
      ...assessment.matches,
    ],
    strategy_tags: [...new Set([
      ...((candidate as StrategyAnnotatedCandidate).strategy_tags ?? []),
      ...assessment.tags,
    ])],
    strategy_watch_points: [...new Set([
      ...((candidate as StrategyAnnotatedCandidate).strategy_watch_points ?? []),
      ...assessment.watchPoints,
    ])],
  }
}

export function annotateCandidatesWithStrategySpecs<T extends StrategyCandidateInput>(
  candidates: T[],
  specs: StrategySpec[],
): Array<T & StrategyAnnotatedCandidate> {
  return candidates.map((candidate) => annotateCandidateWithStrategySpecs(candidate, specs))
}
