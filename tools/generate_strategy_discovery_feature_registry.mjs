import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'data/feature_registry/unified_feature_registry_v1.json')
const pitOverlayPath = resolve(root, 'data/feature_registry/strategy_discovery_pit_overlay_v1.json')
const outputPath = resolve(root, 'worker/src/strategy-discovery/data/formal137-feature-registry.v1.json')
const sourceBytes = readFileSync(sourcePath)
const pitOverlayBytes = readFileSync(pitOverlayPath)
const source = JSON.parse(sourceBytes.toString('utf8'))
const pitOverlay = JSON.parse(pitOverlayBytes.toString('utf8'))
const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
const pitOverlayHash = createHash('sha256').update(pitOverlayBytes).digest('hex')
const unknown = 'UNKNOWN'

const pitFeatures = pitOverlay?.features && typeof pitOverlay.features === 'object' ? pitOverlay.features : {}
for (const [featureId, timing] of Object.entries(pitFeatures)) {
  if (!source.features?.some((row) => row?.feature_id === featureId && row?.eligible_for_strategy === true)) {
    throw new Error(`pit_overlay_unknown_or_ineligible_feature:${featureId}`)
  }
  if (!timing || typeof timing !== 'object') throw new Error(`pit_overlay_invalid:${featureId}`)
  for (const key of ['definition', 'availability_lag', 'earliest_execution']) {
    if (typeof timing[key] !== 'string' || !timing[key].trim() || timing[key] === unknown) {
      throw new Error(`pit_overlay_${key}_invalid:${featureId}`)
    }
  }
  if (!Number.isInteger(timing.lookback_days) || timing.lookback_days < 1) throw new Error(`pit_overlay_lookback_invalid:${featureId}`)
  if (!Array.isArray(timing.evidence_refs) || !timing.evidence_refs.length || timing.evidence_refs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    throw new Error(`pit_overlay_evidence_missing:${featureId}`)
  }
}

const featureCards = (Array.isArray(source.features) ? source.features : [])
  .filter((row) => row?.eligible_for_strategy === true)
  .map((row) => {
    const timing = pitFeatures[row.feature_id]
    const ic5d = Number(row?.triage?.mean_ic_5d)
    const knownRisks = []
    if (row.selector_role === 'evidence_watch') knownRisks.push('evidence_watch_not_direct_challenger_seed')
    if (row.triage?.overlap_tier === 'high_duplicate_ge_0_8') knownRisks.push('high_duplicate_overlap')
    return {
      feature_id: String(row.feature_id),
      name: String(row.feature_id),
      family: String(row.category || row.source_system || 'unknown'),
      definition: timing?.definition || unknown,
      data_source: [String(row.source_system || row.origin_pool || 'unknown')],
      availability_lag: timing?.availability_lag || unknown,
      earliest_execution: timing?.earliest_execution || unknown,
      lookback_days: timing?.lookback_days || unknown,
      point_in_time: timing ? {
        status: 'VERIFIED',
        policy_version: String(pitOverlay.schema_version),
        evidence_refs: timing.evidence_refs,
      } : {
        status: 'UNKNOWN',
        policy_version: String(pitOverlay.schema_version),
        evidence_refs: [],
      },
      missing_rate: unknown,
      outlier_rate: unknown,
      turnover_proxy: unknown,
      correlation_cluster: unknown,
      ic_summary: { '5d': Number.isFinite(ic5d) ? ic5d : unknown },
      regime_summary: {},
      factor_exposure: {},
      used_by_strategies: [],
      known_risks: knownRisks,
      governance: {
        selector_role: String(row.selector_role || 'unknown'),
        promotion_state: String(row.promotion_state || 'unknown'),
        materializer_status: String(row.materializer_status || 'unknown'),
        eligible_for_strategy: true,
      },
    }
  })
  .sort((a, b) => a.feature_id.localeCompare(b.feature_id))

if (featureCards.length !== 137) throw new Error(`formal137_count_mismatch:${featureCards.length}`)

const output = JSON.stringify({
  schema_version: 'strategy-discovery-feature-registry-v1',
  source_schema_version: String(source.schema_version || 'UNKNOWN'),
  source_path: 'data/feature_registry/unified_feature_registry_v1.json',
  source_sha256: sourceHash,
  pit_overlay_path: 'data/feature_registry/strategy_discovery_pit_overlay_v1.json',
  pit_overlay_sha256: pitOverlayHash,
  pit_verified_feature_count: Object.keys(pitFeatures).length,
  feature_count: featureCards.length,
  features: featureCards,
}, null, 2) + '\n'

if (process.argv.includes('--check')) {
  const existing = readFileSync(outputPath, 'utf8')
  if (existing !== output) throw new Error('strategy_discovery_feature_registry_drift')
} else {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, output, 'utf8')
}

process.stdout.write(`formal137=${featureCards.length} source_sha256=${sourceHash}\n`)
