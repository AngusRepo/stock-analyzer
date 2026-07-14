import { STRATEGY_DISCOVERY_PROMPT_VERSION, STRATEGY_DISCOVERY_SCHEMA_VERSION } from './config'
import type { AuditIssue, DeterministicFeatureIntelligence, FeatureCard, PortfolioGapMap, SnapshotManifest, StaticValidationResult, StrategyCandidate, StrategyCard, StrategyHypothesis } from './domain'
import { hashJson, sha256Hex, stableStringify } from './hashing'
import { MODEL_OUTPUT_SCHEMAS } from './modelContracts'
import { LOCKED_TEST_CONTRACT_SCHEMA, PARENT_MUTATION_PAIRED_COMPARISON_SCHEMA } from './lockedTestContract'
import { createStoredZip, jsonZipEntry, type ZipEntryInput } from './zip'

export const REQUIRED_CODEX_OUTPUTS = [
  'final-verdict.json', 'final-report.md', 'strategy-verdicts.json', 'candidate-verdicts.json', 'issue-verdicts.json',
  'tests-executed.json', 'repository-evidence.json', 'unresolved-evidence.json', 'candidate-recommendations.json',
] as const

export interface JuryBundleManifest {
  run_id: string
  created_at: string
  feature_snapshot_hash: string
  strategy_snapshot_hash: string
  bundle_hash: string
  schema_versions: Record<string, string>
  candidate_hashes: Record<string, string>
  required_codex_outputs: string[]
  files: Record<string, string>
}

export interface JuryBundleInput {
  manifest: SnapshotManifest
  features: FeatureCard[]
  strategies: StrategyCard[]
  intelligence: DeterministicFeatureIntelligence
  featureMap: unknown
  gapMap: PortfolioGapMap
  hypotheses: StrategyHypothesis[]
  candidates: StrategyCandidate[]
  staticValidation: StaticValidationResult[]
  shortlist: { shortlist_ids: string[]; rationale: string }
  issues: AuditIssue[]
  crossExamination: unknown
  rawModelResponses: Record<string, unknown>
  promptTranscripts: Record<string, unknown>
  createdAt: string
}

function textEntry(name: string, value: string): ZipEntryInput {
  return { name, data: new TextEncoder().encode(value.endsWith('\n') ? value : `${value}\n`) }
}

function lineage(candidates: StrategyCandidate[]) {
  return candidates.map((row) => ({ candidate_id: row.candidate_id, search_mode: row.search_mode, parent_strategy_id: row.parent_strategy_id, mutation_type: row.mutation_type, candidate_hash: row.candidate_hash }))
}

function testPlan(issues: AuditIssue[]) {
  return {
    policy: 'Select only tests relevant to material issues; record command, exit code, duration, dataset version and evidence path.',
    catalogs: {
      data_leakage: ['feature availability', 'financial announcement date', 'rolling scaler boundary', 'train/test overlap', 'label overlap', 'point-in-time universe', 'next-bar execution'],
      robustness: ['parameter ±10%', 'parameter ±20%', 'leave-one-year-out', 'cost stress', 'slippage stress'],
      methodology: ['multiple-testing correction', 'regime sample sufficiency', 'locked-test isolation', 'parent mutation paired comparison on identical dates, universe and costs'],
    },
    issue_requests: issues.map((issue) => ({ issue_id: issue.issue_id, target_ids: issue.target_ids, test: issue.falsification_test, missing_evidence: issue.missing_evidence })),
  }
}

export async function buildJuryBundle(input: JuryBundleInput): Promise<{ bytes: Uint8Array; manifest: JuryBundleManifest }> {
  const summary = `# Strategy Discovery Jury Bundle\n\n- Run: ${input.manifest.run_id}\n- Feature snapshot: ${input.manifest.feature_snapshot_hash}\n- Strategy snapshot: ${input.manifest.strategy_snapshot_hash}\n- Candidates: ${input.candidates.length}\n- Shortlist: ${input.shortlist.shortlist_ids.join(', ') || 'NONE'}\n\nCloud LLM findings are E0/E1 hypotheses only. Codex repository evidence and executable tests are required for E2-E4.\n`
  const entries: ZipEntryInput[] = [
    textEntry('jury-bundle/run-summary.md', summary),
    jsonZipEntry('jury-bundle/feature-registry-summary.json', { feature_count: input.features.length, features: input.features }),
    jsonZipEntry('jury-bundle/feature-clusters.json', { deterministic: input.intelligence, llm_feature_map: input.featureMap }),
    jsonZipEntry('jury-bundle/portfolio-gap-map.json', input.gapMap),
    jsonZipEntry('jury-bundle/existing-strategies.json', input.strategies),
    jsonZipEntry('jury-bundle/hypotheses.json', input.hypotheses),
    jsonZipEntry('jury-bundle/candidates.json', input.candidates),
    jsonZipEntry('jury-bundle/candidate-lineage.json', lineage(input.candidates)),
    jsonZipEntry('jury-bundle/static-validation.json', input.staticValidation),
    jsonZipEntry('jury-bundle/issues.json', input.issues),
    jsonZipEntry('jury-bundle/cross-examination.json', input.crossExamination),
    jsonZipEntry('jury-bundle/evidence-requests.json', input.issues.map((issue) => ({ issue_id: issue.issue_id, target_ids: issue.target_ids, missing_evidence: issue.missing_evidence, falsification_test: issue.falsification_test }))),
    jsonZipEntry('jury-bundle/test-plan.json', testPlan(input.issues)),
    jsonZipEntry('jury-bundle/locked-test-contract.schema.json', LOCKED_TEST_CONTRACT_SCHEMA),
    jsonZipEntry('jury-bundle/parent-mutation-paired-comparison.schema.json', PARENT_MUTATION_PAIRED_COMPARISON_SCHEMA),
    jsonZipEntry('jury-bundle/source-map.json', { feature_registry: 'data/feature_registry/unified_feature_registry_v1.json', strategy_registry: 'D1 strategy_spec_registry status=active', regime_contract: 'worker/src/lib/marketRegimeState.ts', reward_evidence: 'D1 strategy_reward_ledger', schema_set: 'schemas/strategy-discovery/' }),
  ]
  for (const [name, schema] of Object.entries(MODEL_OUTPUT_SCHEMAS)) entries.push(jsonZipEntry(`jury-bundle/schemas/${name}.schema.json`, schema.schema))
  for (const [role, transcript] of Object.entries(input.promptTranscripts)) entries.push(jsonZipEntry(`jury-bundle/prompts/${role}.json`, transcript))
  for (const [role, raw] of Object.entries(input.rawModelResponses)) entries.push(jsonZipEntry(`jury-bundle/raw-model-responses/${role}.json`, raw))

  const files: Record<string, string> = {}
  for (const entry of entries) files[entry.name] = await sha256Hex(entry.data)
  const candidateHashes = Object.fromEntries(input.candidates.map((row) => [row.candidate_id, row.candidate_hash]))
  const root = {
    run_id: input.manifest.run_id, created_at: input.createdAt,
    feature_snapshot_hash: input.manifest.feature_snapshot_hash, strategy_snapshot_hash: input.manifest.strategy_snapshot_hash,
    schema_versions: { domain: STRATEGY_DISCOVERY_SCHEMA_VERSION, prompts: STRATEGY_DISCOVERY_PROMPT_VERSION },
    candidate_hashes: candidateHashes, required_codex_outputs: [...REQUIRED_CODEX_OUTPUTS], files,
  }
  // Logical Merkle root over all non-manifest files; ZIP byte hash is stored separately by the R2 artifact manifest.
  const manifest: JuryBundleManifest = { ...root, bundle_hash: await hashJson(root) }
  entries.push({ name: 'jury-bundle/manifest.json', data: new TextEncoder().encode(`${stableStringify(manifest)}\n`) })
  return { bytes: createStoredZip(entries), manifest }
}
