import {
  DEFAULT_STRATEGY_SPECS,
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

type StrategyAnnotationSource = StrategyCandidateInput & { score_components?: unknown }

function normalizeStrategyCandidate<T extends StrategyAnnotationSource>(candidate: T): StrategyCandidateInput {
  const { score_components, ...rest } = candidate
  return {
    ...rest,
    score_v2: candidate.score_v2 ?? score_components,
  }
}

export function annotateCandidateWithStrategySpecs<T extends StrategyCandidateInput>(
  candidate: T,
  specs: StrategySpec[] = DEFAULT_STRATEGY_SPECS,
): T & StrategyAnnotatedCandidate {
  assertOwnerCanOwn('screener', 'candidate_discovery')
  assertOwnerCanOwn('strategy', 'strategy_spec')
  const assessment = assessCandidateAgainstStrategySpecs(normalizeStrategyCandidate(candidate), specs)
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
  specs: StrategySpec[] = DEFAULT_STRATEGY_SPECS,
): Array<T & StrategyAnnotatedCandidate> {
  return candidates.map((candidate) => annotateCandidateWithStrategySpecs(candidate, specs))
}
