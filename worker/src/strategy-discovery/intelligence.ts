import { UNKNOWN, type DeterministicFeatureIntelligence, type FeatureCard, type FeatureCluster, type PortfolioGapMap, type StrategyCard } from './domain'

// Canonical runtime families: worker/src/lib/marketRegimeState.ts.
const REGIME_TAXONOMY = ['bull', 'bear', 'volatile', 'sideways'] as const

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function clusterKey(feature: FeatureCard): { id: string; method: FeatureCluster['method'] } {
  if (feature.correlation_cluster !== UNKNOWN && feature.correlation_cluster.trim()) {
    return { id: `source:${feature.correlation_cluster}`, method: 'SOURCE_CORRELATION_CLUSTER' }
  }
  return { id: `family:${feature.family}`, method: 'FAMILY_FALLBACK' }
}

function exactDuplicateGroups(strategies: StrategyCard[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const strategy of strategies) {
    if (!strategy.feature_ids.length) continue
    const fingerprint = unique(strategy.feature_ids).join('|')
    const members = groups.get(fingerprint) ?? []
    members.push(strategy.strategy_id)
    groups.set(fingerprint, members)
  }
  return [...groups.values()].filter((members) => members.length > 1).map((members) => members.sort())
}

export function buildDeterministicFeatureIntelligence(
  features: FeatureCard[],
  strategies: StrategyCard[],
): DeterministicFeatureIntelligence {
  const known = new Set(features.map((feature) => feature.feature_id))
  const familyDistribution: Record<string, number> = {}
  const usage: Record<string, number> = {}
  const mutableClusters = new Map<string, { family: string; features: string[]; strategies: string[]; method: FeatureCluster['method'] }>()
  for (const feature of features) {
    familyDistribution[feature.family] = (familyDistribution[feature.family] ?? 0) + 1
    usage[feature.feature_id] = feature.used_by_strategies.length
    const key = clusterKey(feature)
    const cluster = mutableClusters.get(key.id) ?? { family: feature.family, features: [], strategies: [], method: key.method }
    cluster.features.push(feature.feature_id)
    cluster.strategies.push(...feature.used_by_strategies)
    mutableClusters.set(key.id, cluster)
  }
  const featureClusters: FeatureCluster[] = [...mutableClusters.entries()].map(([clusterId, cluster]) => ({
    cluster_id: clusterId,
    family: cluster.family,
    feature_ids: unique(cluster.features),
    feature_count: cluster.features.length,
    used_feature_count: cluster.features.filter((id) => (usage[id] ?? 0) > 0).length,
    strategy_ids: unique(cluster.strategies),
    method: cluster.method,
  })).sort((a, b) => a.cluster_id.localeCompare(b.cluster_id))
  const strategyCoverage = Object.fromEntries(strategies.map((strategy) => [strategy.strategy_id, {
    known_feature_count: strategy.feature_ids.filter((id) => known.has(id)).length,
    unknown_feature_ids: unique(strategy.feature_ids.filter((id) => !known.has(id))),
  }]))
  return {
    feature_clusters: featureClusters,
    family_distribution: Object.fromEntries(Object.entries(familyDistribution).sort(([a], [b]) => a.localeCompare(b))),
    feature_usage_frequency: Object.fromEntries(Object.entries(usage).sort(([a], [b]) => a.localeCompare(b))),
    strategy_feature_coverage: strategyCoverage,
    exact_feature_duplicate_groups: exactDuplicateGroups(strategies),
    limitations: [
      'Feature correlation is UNKNOWN when the source registry has no correlation_cluster.',
      'Strategy return correlation and selection overlap are UNKNOWN without immutable profiler evidence.',
      'Exact feature duplicates are structural similarity only and are not a return-correlation estimate.',
    ],
  }
}

export function buildPortfolioGapMap(
  features: FeatureCard[],
  strategies: StrategyCard[],
  intelligence: DeterministicFeatureIntelligence,
): PortfolioGapMap {
  const familyUse: Record<string, number> = {}
  const featureById = new Map(features.map((feature) => [feature.feature_id, feature]))
  for (const strategy of strategies) {
    for (const id of unique(strategy.feature_ids)) {
      const family = featureById.get(id)?.family
      if (family) familyUse[family] = (familyUse[family] ?? 0) + 1
    }
  }
  const maxUse = Math.max(0, ...Object.values(familyUse))
  const preferredRegimes = new Set(strategies.flatMap((strategy) => strategy.preferred_regimes.map((value) => value.toLowerCase())))
  const allHoldingUnknown = strategies.every((strategy) => strategy.holding_period === UNKNOWN)
  return {
    overrepresented: Object.entries(familyUse).filter(([, count]) => maxUse > 0 && count >= Math.max(2, Math.ceil(maxUse * 0.75))).map(([family]) => family).sort(),
    underrepresented: intelligence.feature_clusters.filter((cluster) => cluster.used_feature_count === 0).map((cluster) => cluster.family).filter((family, index, all) => all.indexOf(family) === index).sort(),
    missing_regimes: REGIME_TAXONOMY.filter((regime) => !preferredRegimes.has(regime)),
    missing_horizons: allHoldingUnknown ? ['UNKNOWN_REQUIRES_PROFILE'] : [],
    unused_feature_clusters: intelligence.feature_clusters.filter((cluster) => cluster.used_feature_count === 0).map((cluster) => cluster.cluster_id),
    highly_correlated_strategy_groups: intelligence.exact_feature_duplicate_groups,
  }
}
