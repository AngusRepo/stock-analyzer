import { REQUIRED_CODEX_OUTPUTS, type JuryBundleManifest } from './juryBundle'
import { hashJson, sha256Hex } from './hashing'
import { parseStoredZip } from './zip'

const STRATEGY_VERDICTS = new Set(['INVALID', 'BLOCKED', 'RETEST_REQUIRED', 'SURVIVED', 'INSUFFICIENT_EVIDENCE'])
const CANDIDATE_VERDICTS = new Set(['REJECTED', 'BLOCKED', 'RETEST_REQUIRED', 'READY_FOR_LOCKED_TEST', 'INSUFFICIENT_EVIDENCE'])
const ISSUE_VERDICTS = new Set(['CONFIRMED', 'PARTIALLY_CONFIRMED', 'REFUTED', 'UNVERIFIED', 'NOT_APPLICABLE'])
const EVIDENCE_LEVELS = new Set(['E0', 'E1', 'E2', 'E3', 'E4'])
const REQUIRED_ENTRIES = [...REQUIRED_CODEX_OUTPUTS.map((name) => `codex-result/${name}`), 'codex-result/manifest.json']

export interface ValidatedCodexResult {
  manifest: Record<string, any>
  finalVerdict: Record<string, any>
  strategyVerdicts: Array<Record<string, any>>
  candidateVerdicts: Array<Record<string, any>>
  issueVerdicts: Array<Record<string, any>>
  tests: Array<Record<string, any>>
  repositoryEvidence: Array<Record<string, any>>
  unresolvedEvidence: Array<Record<string, any>>
  candidateRecommendations: Array<Record<string, any>>
  bundleManifest: JuryBundleManifest
  bundleCandidates: Array<Record<string, any>>
  bundleStrategies: Array<Record<string, any>>
  bundleIssues: Array<Record<string, any>>
}

function json(files: Map<string, Uint8Array>, name: string): any {
  const bytes = files.get(name)
  if (!bytes) throw new Error(`codex_required_file_missing:${name}`)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error(`codex_invalid_json:${name}`) }
}

function safeText(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (value.length > 100_000) throw new Error(`codex_string_too_large:${path}`)
    if (/<\s*script\b|javascript\s*:|onerror\s*=|onload\s*=/i.test(value)) throw new Error(`codex_active_content_rejected:${path}`)
  } else if (Array.isArray(value)) value.forEach((item, index) => safeText(item, `${path}[${index}]`))
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) safeText(child, `${path}.${key}`)
}

function exactCoverage(rows: any, key: string, expected: Set<string>, label: string, runId: string): Array<Record<string, any>> {
  if (!Array.isArray(rows)) throw new Error(`codex_${label}_array_required`)
  const ids = new Set<string>()
  for (const row of rows) {
    const id = String(row?.[key] ?? '')
    if (!id || ids.has(id) || row?.run_id !== runId) throw new Error(`codex_${label}_identity_invalid:${id}`)
    ids.add(id)
  }
  if (ids.size !== expected.size || [...expected].some((id) => !ids.has(id))) throw new Error(`codex_${label}_coverage_mismatch`)
  return rows
}

export async function validateCodexResultZip(input: { runId: string; resultBytes: Uint8Array; bundleBytes: Uint8Array }): Promise<ValidatedCodexResult> {
  const resultFiles = parseStoredZip(input.resultBytes)
  const bundleFiles = parseStoredZip(input.bundleBytes)
  for (const name of REQUIRED_ENTRIES) if (!resultFiles.has(name)) throw new Error(`codex_required_file_missing:${name}`)
  const manifest = json(resultFiles, 'codex-result/manifest.json')
  const bundleManifest = json(bundleFiles, 'jury-bundle/manifest.json') as JuryBundleManifest
  if (manifest.schema_version !== 'codex-result-v1' || manifest.run_id !== input.runId || bundleManifest.run_id !== input.runId) throw new Error('codex_manifest_run_or_schema_mismatch')
  if (manifest.bundle_hash !== bundleManifest.bundle_hash) throw new Error('codex_bundle_hash_mismatch')
  if (JSON.stringify(manifest.candidate_hashes) !== JSON.stringify(bundleManifest.candidate_hashes)) throw new Error('codex_candidate_hash_manifest_mismatch')
  if (JSON.stringify([...(manifest.required_files ?? [])].sort()) !== JSON.stringify([...REQUIRED_CODEX_OUTPUTS].sort())) throw new Error('codex_required_files_manifest_mismatch')
  for (const [name, expected] of Object.entries(manifest.files ?? {})) {
    const bytes = resultFiles.get(name)
    if (!bytes || await sha256Hex(bytes) !== expected) throw new Error(`codex_result_file_hash_mismatch:${name}`)
  }
  const root = { schema_version: manifest.schema_version, run_id: manifest.run_id, bundle_hash: manifest.bundle_hash,
    candidate_hashes: manifest.candidate_hashes, generated_at: manifest.generated_at, final_verdict: manifest.final_verdict,
    required_files: manifest.required_files, files: manifest.files }
  if (await hashJson(root) !== manifest.result_hash) throw new Error('codex_result_logical_hash_mismatch')

  const bundleCandidates = json(bundleFiles, 'jury-bundle/candidates.json')
  const bundleStrategies = json(bundleFiles, 'jury-bundle/existing-strategies.json')
  const bundleIssues = json(bundleFiles, 'jury-bundle/issues.json')
  if (![bundleCandidates, bundleStrategies, bundleIssues].every(Array.isArray)) throw new Error('codex_bundle_identity_arrays_invalid')
  const strategyVerdicts = exactCoverage(json(resultFiles, 'codex-result/strategy-verdicts.json'), 'strategy_id', new Set(bundleStrategies.map((row: any) => row.strategy_id)), 'strategy_verdicts', input.runId)
  const candidateVerdicts = exactCoverage(json(resultFiles, 'codex-result/candidate-verdicts.json'), 'candidate_id', new Set(bundleCandidates.map((row: any) => row.candidate_id)), 'candidate_verdicts', input.runId)
  const issueVerdicts = exactCoverage(json(resultFiles, 'codex-result/issue-verdicts.json'), 'issue_id', new Set(bundleIssues.map((row: any) => row.issue_id)), 'issue_verdicts', input.runId)
  if (strategyVerdicts.some((row) => !STRATEGY_VERDICTS.has(row.verdict))) throw new Error('codex_strategy_verdict_invalid')
  if (candidateVerdicts.some((row) => !CANDIDATE_VERDICTS.has(row.verdict))) throw new Error('codex_candidate_verdict_invalid')
  for (const row of issueVerdicts) {
    if (!ISSUE_VERDICTS.has(row.verdict) || !EVIDENCE_LEVELS.has(row.evidence_level) || !Array.isArray(row.evidence) || !Array.isArray(row.test_results) || !Array.isArray(row.commands_executed) || !Array.isArray(row.remaining_uncertainty)) throw new Error(`codex_issue_verdict_invalid:${row.issue_id}`)
    if (row.verdict === 'CONFIRMED' && row.severity === 'FATAL' && (!['E2', 'E3', 'E4'].includes(row.evidence_level) || (!row.evidence.length && !row.test_results.length))) throw new Error(`codex_confirmed_fatal_evidence_missing:${row.issue_id}`)
    if (['E0', 'E1'].includes(row.evidence_level) && !['UNVERIFIED', 'REFUTED', 'NOT_APPLICABLE'].includes(row.verdict)) throw new Error(`codex_low_evidence_cannot_confirm:${row.issue_id}`)
  }
  const finalVerdict = json(resultFiles, 'codex-result/final-verdict.json')
  if (finalVerdict.schema_version !== 'codex-final-verdict-v1' || finalVerdict.run_id !== input.runId || finalVerdict.bundle_hash !== bundleManifest.bundle_hash || !finalVerdict.executive_conclusion) throw new Error('codex_final_verdict_invalid')
  const arrays = ['tests-executed.json', 'repository-evidence.json', 'unresolved-evidence.json', 'candidate-recommendations.json'].map((name) => json(resultFiles, `codex-result/${name}`))
  if (!arrays.every(Array.isArray)) throw new Error('codex_supporting_array_invalid')
  for (const [name, bytes] of resultFiles) {
    if (name.endsWith('.md')) safeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes), name)
  }
  const output = { manifest, finalVerdict, strategyVerdicts, candidateVerdicts, issueVerdicts,
    tests: arrays[0], repositoryEvidence: arrays[1], unresolvedEvidence: arrays[2], candidateRecommendations: arrays[3],
    bundleManifest, bundleCandidates, bundleStrategies, bundleIssues }
  safeText(output)
  return output
}

export function buildCodexConclusion(result: ValidatedCodexResult) {
  const invalid = result.strategyVerdicts.filter((row) => row.verdict === 'INVALID')
  const locked = result.candidateVerdicts.filter((row) => row.verdict === 'READY_FOR_LOCKED_TEST')
  const confirmed = result.issueVerdicts.filter((row) => row.verdict === 'CONFIRMED' || row.verdict === 'PARTIALLY_CONFIRMED')
  const refuted = result.issueVerdicts.filter((row) => row.verdict === 'REFUTED' || row.verdict === 'NOT_APPLICABLE')
  const unverifiable = result.issueVerdicts.filter((row) => row.verdict === 'UNVERIFIED')
  const issueById = new Map(result.bundleIssues.map((row) => [row.issue_id, row]))
  const severityOrder: Record<string, number> = { FATAL: 0, MAJOR: 1, MINOR: 2, INFO: 3 }
  const mostSevere = [...confirmed].sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))[0]
  const modelGroups = new Map<string, any[]>()
  for (const verdict of result.issueVerdicts) {
    const model = String(issueById.get(verdict.issue_id)?.critic_model ?? 'UNKNOWN')
    const rows = modelGroups.get(model) ?? []; rows.push(verdict); modelGroups.set(model, rows)
  }
  const redTeamAccuracy = [...modelGroups.entries()].map(([model_id, rows]) => ({ model_id, proposed_count: rows.length,
    confirmed_count: rows.filter((row) => row.verdict === 'CONFIRMED' || row.verdict === 'PARTIALLY_CONFIRMED').length,
    refuted_count: rows.filter((row) => row.verdict === 'REFUTED' || row.verdict === 'NOT_APPLICABLE').length,
    duplicate_count: rows.filter((row) => issueById.get(row.issue_id)?.cross_exam_status === 'DUPLICATE').length,
    unsupported_count: rows.filter((row) => row.verdict === 'UNVERIFIED').length,
    unique_confirmed_count: rows.filter((row) => (row.verdict === 'CONFIRMED' || row.verdict === 'PARTIALLY_CONFIRMED') && !issueById.get(row.issue_id)?.duplicate_of).length }))
  const requested = result.finalVerdict.executive_conclusion
  const confirmsLeakage = confirmed.some((row) => {
    const issue = issueById.get(row.issue_id)
    const evidenceText = JSON.stringify({
      category: issue?.category,
      claim: issue?.claim,
      attack_mechanism: issue?.attack_mechanism,
      evidence: row.evidence,
      test_results: row.test_results,
      required_fix: row.required_fix,
    })
    return /LEAK|POINT.?IN.?TIME|FUTURE|LABEL.?OVERLAP|PURG(?:E|ED|ING)/i.test(evidenceText)
  })
  return {
    run_id: result.manifest.run_id, bundle_hash: result.manifest.bundle_hash,
    executive_conclusion: { overall_health: String(requested.overall_health ?? 'UNKNOWN'),
      most_severe_issue: mostSevere ? String(issueById.get(mostSevere.issue_id)?.claim ?? mostSevere.issue_id) : 'UNKNOWN',
      confirmed_leakage: confirmsLeakage,
      invalid_strategy_count: invalid.length, locked_test_candidate_count: locked.length, summary: String(requested.summary ?? 'UNKNOWN') },
    existing_strategies: result.strategyVerdicts, new_candidates: result.candidateVerdicts,
    red_team_accuracy: redTeamAccuracy, tests: result.tests,
    remaining_uncertainty: { confirmed_issues: confirmed, refuted_issues: refuted, unverifiable_issues: unverifiable,
      missing_data: result.unresolvedEvidence, recommended_next_steps: result.candidateRecommendations },
  }
}
