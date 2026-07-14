import compactRegistry from './data/formal137-feature-registry.v1.json'
import { EXPECTED_FEATURE_COUNT } from './config'
import type { FeatureCard } from './domain'
import { hashJson } from './hashing'
import { validateFeatureCard } from './validators'

export interface FeatureRegistrySnapshot {
  featureVersion: string
  sourcePath: string
  sourceHash: string
  snapshotHash: string
  cards: FeatureCard[]
}
export async function loadFeatureRegistrySnapshot(strategyFeatureUsage: Record<string, string[]> = {}): Promise<FeatureRegistrySnapshot> {
  const source = compactRegistry as unknown as {
    schema_version: string
    source_path: string
    source_sha256: string
    feature_count: number
    features: FeatureCard[]
  }
  if (source.schema_version !== 'strategy-discovery-feature-registry-v1') throw new Error('feature_registry_schema_mismatch')
  if (source.feature_count !== EXPECTED_FEATURE_COUNT || source.features.length !== EXPECTED_FEATURE_COUNT) {
    throw new Error(`feature_registry_count_mismatch:${source.features.length}:${EXPECTED_FEATURE_COUNT}`)
  }
  const cards = source.features.map((card) => ({
    ...card,
    data_source: [...card.data_source],
    used_by_strategies: [...(strategyFeatureUsage[card.feature_id] ?? [])].sort(),
    known_risks: [...card.known_risks],
    ic_summary: { ...card.ic_summary },
    regime_summary: { ...card.regime_summary },
    factor_exposure: { ...card.factor_exposure },
    governance: { ...card.governance },
  })).sort((a, b) => a.feature_id.localeCompare(b.feature_id))
  const errors = cards.flatMap((card, index) => validateFeatureCard(card).errors.map((error) => `feature[${index}]:${error}`))
  if (errors.length) throw new Error(`feature_registry_validation_failed:${errors.slice(0, 10).join(',')}`)
  const snapshotHash = await hashJson(cards)
  return {
    featureVersion: `FV-${source.source_sha256.slice(0, 16)}`,
    sourcePath: source.source_path,
    sourceHash: source.source_sha256,
    snapshotHash,
    cards,
  }
}
