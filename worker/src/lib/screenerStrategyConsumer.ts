import {
  assessCandidateAgainstStrategySpecs,
  normalizeStrategySpecGovernance,
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

export interface StrategyPoolAttributionCandidate extends StrategyAnnotatedCandidate {
  strategy_pool_ids?: string[]
  strategy_family_ids?: string[]
  strategy_variant_ids?: string[]
  strategy_owner_types?: string[]
  research_strategy_ids?: string[]
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function isProductionStrategyOwner(spec: StrategySpec): boolean {
  return spec.status === 'active' && spec.ownerType === 'strategy' && spec.promotionStatus === 'production'
}

function specSupportsRegime(spec: StrategySpec, regime?: string | null): boolean {
  const current = String(regime ?? '').trim().toLowerCase()
  if (!current || current === 'unknown' || current === 'all') return true
  return spec.supportedRegimes.map(String).map((item) => item.toLowerCase()).includes(current)
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

export function reconcileCandidateStrategyPoolAttribution<T extends StrategyPoolAttributionCandidate>(
  candidate: T,
  specs: StrategySpec[],
  options: { regime?: string | null } = {},
): T {
  assertOwnerCanOwn('screener', 'candidate_discovery')
  assertOwnerCanOwn('strategy', 'strategy_spec')
  const normalizedSpecs = specs.map(normalizeStrategySpecGovernance)
  const assessment = assessCandidateAgainstStrategySpecs(candidate, normalizedSpecs)
  const specsById = new Map(normalizedSpecs.map((spec) => [spec.id, spec]))
  const productionMatches = assessment.matches
    .map((match) => specsById.get(match.specId))
    .filter((spec): spec is StrategySpec => Boolean(
      spec && isProductionStrategyOwner(spec) && specSupportsRegime(spec, options.regime),
    ))
  const researchMatches = assessment.matches
    .map((match) => specsById.get(match.specId))
    .filter((spec): spec is StrategySpec => Boolean(
      spec && (!isProductionStrategyOwner(spec) || !specSupportsRegime(spec, options.regime)),
    ))

  const addedProductionIds = productionMatches
    .map((spec) => spec.id)
    .filter((id) => !(candidate.strategy_pool_ids ?? []).includes(id))

  return {
    ...candidate,
    strategy_matches: uniqueStrings([
      ...((candidate.strategy_matches ?? []).map((match) => match.specId)),
      ...assessment.matches.map((match) => match.specId),
    ]).map((specId) =>
      [...(candidate.strategy_matches ?? []), ...assessment.matches].find((match) => match.specId === specId)!,
    ),
    strategy_pool_ids: uniqueStrings([
      ...(candidate.strategy_pool_ids ?? []),
      ...productionMatches.map((spec) => spec.id),
    ]),
    strategy_family_ids: uniqueStrings([
      ...(candidate.strategy_family_ids ?? []),
      ...productionMatches.map((spec) => spec.familyId),
    ]),
    strategy_variant_ids: uniqueStrings([
      ...(candidate.strategy_variant_ids ?? []),
      ...productionMatches.map((spec) => spec.variantId),
    ]),
    strategy_owner_types: uniqueStrings([
      ...(candidate.strategy_owner_types ?? []),
      ...(productionMatches.length ? ['strategy'] : []),
    ]),
    research_strategy_ids: uniqueStrings([
      ...(candidate.research_strategy_ids ?? []),
      ...researchMatches.map((spec) => spec.id),
    ]),
    strategy_tags: uniqueStrings([
      ...(candidate.strategy_tags ?? []),
      ...assessment.tags,
      ...productionMatches.map((spec) => `strategy:${spec.id}`),
      ...productionMatches.map((spec) => `strategy_family:${spec.familyId}`),
    ]),
    strategy_watch_points: uniqueStrings([
      ...(candidate.strategy_watch_points ?? []),
      ...(addedProductionIds.length ? ['strategy_pool_attribution_reconciled_from_strict_spec_assessment'] : []),
      ...addedProductionIds.map((id) => `strategy_pool_reconciled_added:${id}`),
      ...assessment.watchPoints,
    ]),
  }
}

export function reconcileCandidatesStrategyPoolAttribution<T extends StrategyPoolAttributionCandidate>(
  candidates: T[],
  specs: StrategySpec[],
  options: { regime?: string | null } = {},
): T[] {
  return candidates.map((candidate) => reconcileCandidateStrategyPoolAttribution(candidate, specs, options))
}
