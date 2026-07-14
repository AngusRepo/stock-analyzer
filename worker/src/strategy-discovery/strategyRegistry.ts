import { EXPECTED_STRATEGY_COUNT } from './config'
import { UNKNOWN, type StrategyCard } from './domain'
import { hashJson } from './hashing'
import { validateStrategyCard } from './validators'

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function collectFeatureRefs(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) collectFeatureRefs(child, output)
    return output
  }
  const row = objectValue(value)
  if (typeof row.featureRef === 'string' && row.featureRef.trim()) output.add(row.featureRef.trim())
  for (const child of Object.values(row)) collectFeatureRefs(child, output)
  return output
}

function collectRuntimeSignals(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) collectRuntimeSignals(child, output)
    return output
  }
  const row = objectValue(value)
  if (typeof row.signal === 'string' && row.signal.trim()) output.add(`runtime_signal:${row.signal.trim()}`)
  for (const child of Object.values(row)) collectRuntimeSignals(child, output)
  return output
}

function collectThresholdDependencies(thresholds: Record<string, unknown>): string[] {
  const dependencies = collectFeatureRefs(thresholds.featureRefs)
  for (const signal of collectRuntimeSignals(thresholds.dsl)) dependencies.add(signal)
  for (const key of Object.keys(thresholds)) {
    if (['featureRefs', 'dsl', 'technicalStrategy', 'minPrice', 'maxPrice'].includes(key)) continue
    if (/^(min|max)/.test(key)) dependencies.add(`threshold:${key}`)
  }
  return [...dependencies].sort()
}

function rowString(row: Record<string, unknown>, key: string, fallback = ''): string {
  const value = row[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function strategyCardFromRegistryRow(row: Record<string, unknown>): StrategyCard {
  const thresholds = jsonValue<Record<string, unknown>>(row.thresholds_json, {})
  const candidatePolicy = jsonValue<Record<string, unknown>>(row.candidate_policy_json, {})
  const regimes = jsonValue<string[]>(row.supported_regimes_json, [])
  const riskNotes = jsonValue<string[]>(row.risk_notes_json, [])
  const sourceRefs = jsonValue<string[]>(row.source_refs_json, [])
  const featureIds = collectThresholdDependencies(thresholds)
  const strategyId = rowString(row, 'strategy_id')
  return {
    strategy_id: strategyId,
    version: rowString(row, 'version'),
    name: rowString(row, 'name', strategyId),
    hypothesis: rowString(row, 'thesis', UNKNOWN),
    feature_ids: featureIds,
    entry_rules: thresholds.dsl ? [thresholds.dsl] : [thresholds],
    exit_rules: [{ status: UNKNOWN, owner: 'shared_exit_policy_not_embedded_in_strategy_registry' }],
    holding_period: UNKNOWN,
    execution_timing: UNKNOWN,
    transaction_cost: UNKNOWN,
    preferred_regimes: Array.isArray(regimes) ? regimes.map(String) : [],
    failure_regimes: [],
    annual_performance: {},
    regime_performance: {},
    factor_exposure: {},
    signal_correlation: {},
    selection_overlap: {},
    known_failures: Array.isArray(riskNotes) ? riskNotes.map(String) : [],
    source_references: [...(Array.isArray(sourceRefs) ? sourceRefs.map(String) : []), `d1:strategy_spec_registry:${strategyId}`],
    governance: {
      status: rowString(row, 'status'),
      owner_type: rowString(row, 'owner_type', 'strategy'),
      promotion_status: rowString(row, 'promotion_status', 'unknown'),
      alpha_bucket: rowString(row, 'alpha_bucket', 'unknown'),
      family_id: rowString(row, 'family_id', 'unknown'),
      variant_id: rowString(row, 'variant_id', ''),
    },
  }
}

export interface StrategyRegistrySnapshot {
  strategyVersion: string
  source: string
  snapshotHash: string
  cardHashes: Record<string, string>
  cards: StrategyCard[]
  featureUsage: Record<string, string[]>
}

export async function buildStrategyRegistrySnapshot(rows: Record<string, unknown>[]): Promise<StrategyRegistrySnapshot> {
  if (rows.length !== EXPECTED_STRATEGY_COUNT) throw new Error(`strategy_count_mismatch:${rows.length}:${EXPECTED_STRATEGY_COUNT}`)
  const cards = rows.map(strategyCardFromRegistryRow).sort((a, b) => a.strategy_id.localeCompare(b.strategy_id))
  const ids = new Set<string>()
  const errors: string[] = []
  for (const [index, card] of cards.entries()) {
    if (ids.has(card.strategy_id)) errors.push(`strategy_duplicate_id:${card.strategy_id}`)
    ids.add(card.strategy_id)
    errors.push(...validateStrategyCard(card).errors.map((error) => `strategy[${index}]:${error}`))
  }
  if (errors.length) throw new Error(`strategy_registry_validation_failed:${errors.slice(0, 10).join(',')}`)
  const cardHashes: Record<string, string> = {}
  const featureUsage: Record<string, string[]> = {}
  for (const card of cards) {
    cardHashes[card.strategy_id] = await hashJson(card)
    for (const featureId of card.feature_ids) (featureUsage[featureId] ??= []).push(card.strategy_id)
  }
  const snapshotHash = await hashJson(cards)
  return {
    strategyVersion: `SV-${snapshotHash.slice(0, 16)}`,
    source: 'd1:strategy_spec_registry:status=active',
    snapshotHash,
    cardHashes,
    cards,
    featureUsage,
  }
}

export function strategyRegistryCandidatePolicy(card: StrategyCard): Record<string, unknown> {
  return objectValue(card.entry_rules[0])
}
