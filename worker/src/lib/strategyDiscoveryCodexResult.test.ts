import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildCodexConclusion, validateCodexResultZip } from '../strategy-discovery/codexResult'
import { hashJson, sha256Hex, stableStringify } from '../strategy-discovery/hashing'
import { buildJuryBundle, REQUIRED_CODEX_OUTPUTS } from '../strategy-discovery/juryBundle'
import { createStoredZip, parseStoredZip, type ZipEntryInput } from '../strategy-discovery/zip'
import { UNKNOWN, type AuditIssue, type StrategyCandidate, type StrategyCard } from '../strategy-discovery/domain'

const runId = 'RUN-CODEX-1'

function strategy(): StrategyCard {
  return { strategy_id: 'S01', version: 'v1', name: 'S01', hypothesis: 'h', feature_ids: ['f1'], entry_rules: [{}], exit_rules: [{}], holding_period: UNKNOWN, execution_timing: UNKNOWN, transaction_cost: UNKNOWN, preferred_regimes: [], failure_regimes: [], annual_performance: {}, regime_performance: {}, factor_exposure: {}, signal_correlation: {}, selection_overlap: {}, known_failures: [], source_references: [], governance: { status: 'active', owner_type: 'strategy', promotion_status: 'production', alpha_bucket: 'x', family_id: 'x', variant_id: '' } }
}

async function candidate(): Promise<StrategyCandidate> {
  const row: StrategyCandidate = { candidate_id: 'CAND-001', run_id: runId, search_mode: 'MODE_C_PORTFOLIO_GAP', parent_strategy_id: null, mutation_type: null, hypothesis: 'h', economic_mechanism: 'm', portfolio_gap: 'g', preferred_regimes: [], minimum_regime_samples: UNKNOWN, dsl: { feature_ids: ['f1'], parameters: {}, regime_gate: null, entry_rules: [{}], exit_rules: [{}], signal_time: 'T_CLOSE', execution_time: 'T_PLUS_1_OPEN', falsification_condition: 'x', lags: [1] }, candidate_hash: '', source_model: 'fixture', source_type: 'FIXTURE' }
  row.candidate_hash = await hashJson(row)
  return row
}

function issue(): AuditIssue {
  return { issue_id: 'ISS-001', run_id: runId, target_type: 'CANDIDATE', target_ids: ['CAND-001'], category: 'temporal_mismatch', claim: 'possible timing defect', attack_mechanism: 'timing', observed_evidence: [], missing_evidence: ['test'], severity_if_true: 'MAJOR', evidence_level: 'E1', critic_model: 'qwen', critic_confidence: 0.7, falsification_test: {}, blocks_if_confirmed: true, cross_exam_status: 'POSSIBLE_BUT_UNVERIFIED', duplicate_of: null }
}

async function resultZip(bundleHash: string, candidateHash: string, changes: { omit?: string; issueVerdict?: any; report?: string } = {}): Promise<Uint8Array> {
  const values: Record<string, string | unknown> = {
    'final-verdict.json': { schema_version: 'codex-final-verdict-v1', run_id: runId, bundle_hash: bundleHash, executive_conclusion: { overall_health: 'INSUFFICIENT_EVIDENCE', most_severe_issue: 'UNKNOWN', confirmed_leakage: false, invalid_strategy_count: 0, locked_test_candidate_count: 1, summary: 'Evidence remains limited.' } },
    'final-report.md': changes.report ?? '# Final report\n',
    'strategy-verdicts.json': [{ run_id: runId, strategy_id: 'S01', verdict: 'SURVIVED', confirmed_fatal: 0, confirmed_major: 0, refuted_issues: 0, incomplete_tests: [], summary: 'No confirmed defect.' }],
    'candidate-verdicts.json': [{ run_id: runId, candidate_id: 'CAND-001', verdict: 'READY_FOR_LOCKED_TEST', search_mode: 'MODE_C_PORTFOLIO_GAP', locked_test_eligible: true, required_tests: [] }],
    'issue-verdicts.json': [changes.issueVerdict ?? { run_id: runId, issue_id: 'ISS-001', verdict: 'UNVERIFIED', severity: 'MAJOR', evidence_level: 'E1', evidence: [], commands_executed: [], test_results: [], remaining_uncertainty: ['test missing'], required_fix: 'run test', blocks_target: false }],
    'tests-executed.json': [], 'repository-evidence.json': [], 'unresolved-evidence.json': [{ issue_id: 'ISS-001', reason: 'test missing' }],
    'candidate-recommendations.json': [{ candidate_id: 'CAND-001', locked_test_eligible: true, forward_shadow: false }],
  }
  const entries: ZipEntryInput[] = []
  for (const name of REQUIRED_CODEX_OUTPUTS) {
    if (name === changes.omit) continue
    const value = values[name]
    const text = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`
    entries.push({ name: `codex-result/${name}`, data: new TextEncoder().encode(text) })
  }
  const files = Object.fromEntries(await Promise.all(entries.map(async (entry) => [entry.name, await sha256Hex(entry.data)])))
  const root = { schema_version: 'codex-result-v1', run_id: runId, bundle_hash: bundleHash, candidate_hashes: { 'CAND-001': candidateHash },
    generated_at: '2026-07-11T00:00:00.000Z', final_verdict: (values['final-verdict.json'] as any).executive_conclusion,
    required_files: [...REQUIRED_CODEX_OUTPUTS], files }
  entries.push({ name: 'codex-result/manifest.json', data: new TextEncoder().encode(`${stableStringify({ ...root, result_hash: await hashJson(root) })}\n`) })
  return createStoredZip(entries)
}

async function main() {
  const c = await candidate()
  const i = issue()
  const jury = await buildJuryBundle({ manifest: { schema_version: 'v1', run_id: runId, created_at: '2026-07-11T00:00:00.000Z', feature_version: 'FV', strategy_version: 'SV', feature_snapshot_hash: 'b'.repeat(64), strategy_snapshot_hash: 'c'.repeat(64), system_profile_hash: 'd'.repeat(64), input_hash: 'e'.repeat(64), feature_count: 1, strategy_count: 1, fixture_mode: true }, features: [], strategies: [strategy()], intelligence: { feature_clusters: [], family_distribution: {}, feature_usage_frequency: {}, strategy_feature_coverage: {}, exact_feature_duplicate_groups: [], limitations: [] }, featureMap: {}, gapMap: { overrepresented: [], underrepresented: [], missing_regimes: [], missing_horizons: [], unused_feature_clusters: [], highly_correlated_strategy_groups: [] }, hypotheses: [], candidates: [c], staticValidation: [], shortlist: { shortlist_ids: [c.candidate_id], rationale: 'fixture' }, issues: [i], crossExamination: {}, rawModelResponses: {}, promptTranscripts: {}, createdAt: '2026-07-11T00:00:00.000Z' })
  const validResultBytes = await resultZip(jury.manifest.bundle_hash, c.candidate_hash)
  const valid = await validateCodexResultZip({ runId, bundleBytes: jury.bytes, resultBytes: validResultBytes })
  const conclusion = buildCodexConclusion(valid)
  assert.equal(conclusion.executive_conclusion.locked_test_candidate_count, 1)
  assert.equal(conclusion.executive_conclusion.confirmed_leakage, false)
  const confirmedLeakage = { run_id: runId, issue_id: 'ISS-001', verdict: 'PARTIALLY_CONFIRMED', severity: 'MAJOR', evidence_level: 'E3',
    evidence: ['Executable reproduction found unpurged label overlap.'], commands_executed: ['reproduce_label_overlap'], test_results: ['PASS: overlap reproduced'],
    remaining_uncertainty: ['Candidate-specific path usage is unverified.'], required_fix: 'Purge the forward label horizon.', blocks_target: true }
  const confirmedLeakageBytes = await resultZip(jury.manifest.bundle_hash, c.candidate_hash, { issueVerdict: confirmedLeakage })
  const confirmedLeakageResult = await validateCodexResultZip({ runId, bundleBytes: jury.bytes, resultBytes: confirmedLeakageBytes })
  assert.equal(buildCodexConclusion(confirmedLeakageResult).executive_conclusion.confirmed_leakage, true)
  await assert.rejects(async () => validateCodexResultZip({ runId, bundleBytes: jury.bytes, resultBytes: await resultZip(jury.manifest.bundle_hash, c.candidate_hash, { omit: 'tests-executed.json' }) }), /codex_required_file_missing/)
  const fatal = { run_id: runId, issue_id: 'ISS-001', verdict: 'CONFIRMED', severity: 'FATAL', evidence_level: 'E1', evidence: [], commands_executed: [], test_results: [], remaining_uncertainty: [], required_fix: 'x', blocks_target: true }
  await assert.rejects(async () => validateCodexResultZip({ runId, bundleBytes: jury.bytes, resultBytes: await resultZip(jury.manifest.bundle_hash, c.candidate_hash, { issueVerdict: fatal }) }), /codex_confirmed_fatal_evidence_missing|codex_low_evidence_cannot_confirm/)
  await assert.rejects(async () => validateCodexResultZip({ runId, bundleBytes: jury.bytes, resultBytes: await resultZip(jury.manifest.bundle_hash, c.candidate_hash, { report: '<script>alert(1)</script>' }) }), /codex_active_content_rejected/)
  await assert.rejects(() => validateCodexResultZip({ runId: 'RUN-OTHER', bundleBytes: jury.bytes, resultBytes: validResultBytes }), /codex_manifest_run_or_schema_mismatch/)
  await assert.rejects(async () => validateCodexResultZip({ runId, bundleBytes: jury.bytes, resultBytes: await resultZip(jury.manifest.bundle_hash, 'f'.repeat(64)) }), /codex_candidate_hash_manifest_mismatch/)
  const unknownIssue = { run_id: runId, issue_id: 'ISS-UNKNOWN', verdict: 'UNVERIFIED', severity: 'MAJOR', evidence_level: 'E1', evidence: [], commands_executed: [], test_results: [], remaining_uncertainty: [], required_fix: 'x', blocks_target: false }
  await assert.rejects(async () => validateCodexResultZip({ runId, bundleBytes: jury.bytes, resultBytes: await resultZip(jury.manifest.bundle_hash, c.candidate_hash, { issueVerdict: unknownIssue }) }), /codex_issue_verdicts_coverage_mismatch/)
  if (process.argv.includes('--emit-skill-fixture')) {
    const root = resolve(process.cwd(), '..', '.tmp', 'strategy-discovery-skill-e2e')
    const outbox = resolve(root, runId)
    mkdirSync(outbox, { recursive: true })
    writeFileSync(resolve(root, 'jury-bundle.zip'), jury.bytes)
    for (const [name, bytes] of parseStoredZip(validResultBytes)) {
      if (!name.startsWith('codex-result/') || name.endsWith('/manifest.json')) continue
      writeFileSync(resolve(outbox, name.slice('codex-result/'.length)), bytes)
    }
    console.log(JSON.stringify({ root, outbox, bundle: resolve(root, 'jury-bundle.zip') }))
  }
}

void main()
