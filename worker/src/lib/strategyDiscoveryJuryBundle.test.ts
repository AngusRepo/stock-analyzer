import assert from 'node:assert/strict'
import { buildJuryBundle, REQUIRED_CODEX_OUTPUTS } from '../strategy-discovery/juryBundle'
import { parseStoredZip } from '../strategy-discovery/zip'
import { sha256Hex } from '../strategy-discovery/hashing'
import { UNKNOWN, type StrategyCandidate } from '../strategy-discovery/domain'

async function main() {
  const candidate: StrategyCandidate = { candidate_id: 'CAND-001', run_id: 'RUN-1', search_mode: 'MODE_C_PORTFOLIO_GAP', parent_strategy_id: null, mutation_type: null, hypothesis: 'h', economic_mechanism: 'm', portfolio_gap: 'g', preferred_regimes: [], minimum_regime_samples: UNKNOWN, dsl: { feature_ids: ['f1'], parameters: {}, regime_gate: null, entry_rules: [{}], exit_rules: [{}], signal_time: 'T_CLOSE', execution_time: 'T_PLUS_1_OPEN', falsification_condition: 'x', lags: [1] }, candidate_hash: 'a'.repeat(64), source_model: 'fixture', source_type: 'FIXTURE' }
  const bundle = await buildJuryBundle({ manifest: { schema_version: 'v1', run_id: 'RUN-1', created_at: '2026-07-11T00:00:00.000Z', feature_version: 'FV', strategy_version: 'SV', feature_snapshot_hash: 'b'.repeat(64), strategy_snapshot_hash: 'c'.repeat(64), system_profile_hash: 'd'.repeat(64), input_hash: 'e'.repeat(64), feature_count: 1, strategy_count: 1, fixture_mode: true }, features: [], strategies: [], intelligence: { feature_clusters: [], family_distribution: {}, feature_usage_frequency: {}, strategy_feature_coverage: {}, exact_feature_duplicate_groups: [], limitations: [] }, featureMap: {}, gapMap: { overrepresented: [], underrepresented: [], missing_regimes: [], missing_horizons: [], unused_feature_clusters: [], highly_correlated_strategy_groups: [] }, hypotheses: [], candidates: [candidate], staticValidation: [], shortlist: { shortlist_ids: ['CAND-001'], rationale: 'fixture' }, issues: [], crossExamination: {}, rawModelResponses: { QWEN: {} }, promptTranscripts: { QWEN: {} }, createdAt: '2026-07-11T00:00:00.000Z' })
  const entries = parseStoredZip(bundle.bytes)
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('jury-bundle/manifest.json')!))
  assert.equal(manifest.bundle_hash, bundle.manifest.bundle_hash)
  assert.equal(manifest.candidate_hashes['CAND-001'], candidate.candidate_hash)
  assert.deepEqual(manifest.required_codex_outputs, [...REQUIRED_CODEX_OUTPUTS])
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(await sha256Hex(entries.get(name)!), hash)
  assert.ok(entries.has('jury-bundle/raw-model-responses/QWEN.json'))
  assert.ok(entries.has('jury-bundle/test-plan.json'))
}

void main()
