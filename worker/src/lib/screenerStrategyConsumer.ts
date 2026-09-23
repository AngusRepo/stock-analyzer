import {
  assessCandidateAgainstStrategySpecs,
  normalizeStrategySpecGovernance,
  type StrategyCandidateInput,
  type StrategySpec,
  type StrategySpecEvaluationOptions,
} from './strategySpec'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

// Existing screener snapshots can contain the original five-field match shape.
// Preserve it accurately; do not assert or fabricate newer assessment metrics.
export interface InheritedStrategyMatch {
  specId: string
  alphaBucket: string
  status: string
  label: string
  reason: string
  matchStrength?: number
  thresholdMargin?: number
  evidenceCount?: number
}

export interface StrategyAnnotatedCandidate extends StrategyCandidateInput {
  strategy_matches?: InheritedStrategyMatch[]
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
  options: StrategySpecEvaluationOptions = {},
): T & StrategyAnnotatedCandidate {
  assertOwnerCanOwn('screener', 'candidate_discovery')
  assertOwnerCanOwn('strategy', 'strategy_spec')
  const assessment = assessCandidateAgainstStrategySpecs(candidate, specs, options)
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
  options: StrategySpecEvaluationOptions = {},
): Array<T & StrategyAnnotatedCandidate> {
  return candidates.map((candidate) => annotateCandidateWithStrategySpecs(candidate, specs, options))
}

export function reconcileCandidateStrategyPoolAttribution<T extends StrategyPoolAttributionCandidate>(
  candidate: T,
  specs: StrategySpec[],
  options: StrategySpecEvaluationOptions & { regime?: string | null } = {},
): T {
  assertOwnerCanOwn('screener', 'candidate_discovery')
  assertOwnerCanOwn('strategy', 'strategy_spec')
  const normalizedSpecs = specs.map(normalizeStrategySpecGovernance)
  const assessment = assessCandidateAgainstStrategySpecs(candidate, normalizedSpecs, options)
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

  const productionIds = new Set(productionMatches.map((spec) => spec.id))
  const assessedIds = new Set(assessment.matches.map((match) => match.specId))
  const knownFamilies = new Set<string>(normalizedSpecs.map((spec) => String(spec.familyId ?? '')).filter(Boolean))
  const productionFamilies = new Set<string>(productionMatches.map((spec) => String(spec.familyId ?? '')).filter(Boolean))
  const knownVariants = new Set(normalizedSpecs.map((spec) => spec.variantId).filter(Boolean))
  const productionVariants = new Set(productionMatches.map((spec) => spec.variantId))
  const inheritedPoolIds = (candidate.strategy_pool_ids ?? [])
    .filter((id) => !specsById.has(id) || productionIds.has(id))
  const inheritedMatches = (candidate.strategy_matches ?? [])
    .filter((match) => !specsById.has(match.specId) || assessedIds.has(match.specId))
  const inheritedTags = (candidate.strategy_tags ?? []).filter((tag) => {
    if (tag.startsWith('strategy:')) {
      const id = tag.slice('strategy:'.length)
      return !specsById.has(id) || productionIds.has(id)
    }
    if (tag.startsWith('strategy_family:')) {
      const id = tag.slice('strategy_family:'.length)
      return !knownFamilies.has(id) || productionFamilies.has(id)
    }
    return true
  })
  const addedProductionIds = productionMatches
    .map((spec) => spec.id)
    .filter((id) => !inheritedPoolIds.includes(id))

  return {
    ...candidate,
    strategy_matches: uniqueStrings([
      ...inheritedMatches.map((match) => match.specId),
      ...assessment.matches.map((match) => match.specId),
    ]).map((specId) =>
      [...assessment.matches, ...inheritedMatches].find((match) => match.specId === specId)!,
    ),
    strategy_pool_ids: uniqueStrings([
      ...inheritedPoolIds,
      ...productionMatches.map((spec) => spec.id),
    ]),
    strategy_family_ids: uniqueStrings([
      ...(candidate.strategy_family_ids ?? []).filter((id) => !knownFamilies.has(id) || productionFamilies.has(id)),
      ...productionMatches.map((spec) => spec.familyId),
    ]),
    strategy_variant_ids: uniqueStrings([
      ...(candidate.strategy_variant_ids ?? []).filter((id) => !knownVariants.has(id) || productionVariants.has(id)),
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
      ...inheritedTags,
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
  options: StrategySpecEvaluationOptions & { regime?: string | null } = {},
): T[] {
  return candidates.map((candidate) => reconcileCandidateStrategyPoolAttribution(candidate, specs, options))
}
