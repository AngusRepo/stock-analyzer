import assert from 'node:assert/strict'
import { createStoredZip, parseStoredZip, type ZipEntryInput } from '../strategy-discovery/zip'
import { hashJson, sha256Hex, stableStringify } from '../strategy-discovery/hashing'
import { REQUIRED_CODEX_OUTPUTS } from '../strategy-discovery/juryBundle'

const base = process.argv[2] ?? 'http://127.0.0.1:8787/api'
const key = `fixture-e2e:${crypto.randomUUID()}`

async function json(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${base}${path}`, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(payload)}`)
  return payload
}

async function main() {
  const initial = await json('/dashboard-state')
  assert.equal(initial.current_snapshot.feature_count, 137)
  assert.equal(initial.current_snapshot.strategy_count, 13)
  assert.ok(['READY', 'COMPLETED'].includes(initial.analysis_button.state), initial.analysis_button.state)

  const start = await json('/full-analysis', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ fixture_mode: true }) })
  assert.equal(start.status, 'RUNNING')
  const replay = await json('/full-analysis', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ fixture_mode: true }) })
  assert.equal(replay.run_id, start.run_id)
  assert.equal(replay.idempotent_replay, true)

  let status: any
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    status = await json(`/runs/${start.run_id}/status`)
    if (['CODEX_HANDOFF_READY', 'FAILED_RECOVERABLE', 'BLOCKED'].includes(status.status)) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  assert.equal(status?.status, 'CODEX_HANDOFF_READY', JSON.stringify(status))
  assert.equal(status.completed_steps, 12)
  assert.equal(status.fixture_mode, true)
  assert.match(status.feature_version, /^FV-/)
  assert.match(status.strategy_version, /^SV-/)
  assert.match(status.input_hash, /^[a-f0-9]{64}$/)
  assert.equal(status.prompt_set_version, 'strategy-discovery-prompts-v1')
  assert.equal(status.schema_set_version, 'strategy-discovery-schema-v1')

  const dashboard = await json('/dashboard-state')
  assert.equal(dashboard.codex_button.state, 'HANDOFF_READY')
  assert.ok(/^[a-f0-9]{64}$/.test(dashboard.codex_handoff.bundle_hash))
  const report = await json(`/runs/${start.run_id}/report`)
  assert.equal(report.fixture_mode, true)
  assert.match(report.disclaimer, /FIXTURE/)
  assert.equal(report.candidates.length, 12)
  assert.ok(report.shortlist.shortlist_ids.length <= 5)

  const bundleResponse = await fetch(`${base}/runs/${start.run_id}/jury-bundle`)
  assert.equal(bundleResponse.status, 200)
  const bundle = parseStoredZip(new Uint8Array(await bundleResponse.arrayBuffer()))
  const manifest = JSON.parse(new TextDecoder().decode(bundle.get('jury-bundle/manifest.json')!))
  assert.equal(manifest.run_id, start.run_id)
  assert.equal(manifest.bundle_hash, dashboard.codex_handoff.bundle_hash)
  assert.equal(Object.keys(manifest.candidate_hashes).length, 12)
  assert.ok(bundle.has('jury-bundle/raw-model-responses/PORTFOLIO_JUDGE.json'))
  const strategies = JSON.parse(new TextDecoder().decode(bundle.get('jury-bundle/existing-strategies.json')!))
  const candidates = JSON.parse(new TextDecoder().decode(bundle.get('jury-bundle/candidates.json')!))
  const featureSummary = JSON.parse(new TextDecoder().decode(bundle.get('jury-bundle/feature-registry-summary.json')!))
  const issues = JSON.parse(new TextDecoder().decode(bundle.get('jury-bundle/issues.json')!))
  const privacyRoles = ['PORTFOLIO_JUDGE', 'DATA_PROSECUTOR', 'EXECUTION_PROSECUTOR', 'ECONOMIC_PROSECUTOR', 'CROSS_EXAMINER']
  const forbiddenPromptKeys = [
    'run_id', 'candidate_id', 'candidate_hash', 'strategy_id', 'parent_strategy_id', 'feature_id', 'feature_ids',
    'dsl', 'parameters', 'regime_gate', 'entry_rules', 'exit_rules', 'hypothesis', 'economic_mechanism',
    'falsification_condition', 'source_model', 'source_type', 'data_source', 'governance', 'system_profile',
  ]
  const forbiddenPromptValues = [
    start.run_id,
    ...candidates.flatMap((row: any) => [row.candidate_id, row.candidate_hash, row.parent_strategy_id]).filter(Boolean),
    ...strategies.map((row: any) => row.strategy_id).filter(Boolean),
    ...featureSummary.features.map((row: any) => row.feature_id).filter(Boolean),
  ]
  for (const role of privacyRoles) {
    const promptBytes = bundle.get(`jury-bundle/prompts/${role}.json`)
    assert.ok(promptBytes, `missing privacy prompt transcript: ${role}`)
    const prompt = new TextDecoder().decode(promptBytes)
    assert.match(prompt, /strategy-discovery-privacy-v1/)
    for (const key of forbiddenPromptKeys) assert.equal(new RegExp(`"${key}"\\s*:`).test(prompt), false, `${role} leaked forbidden key ${key}`)
    for (const value of forbiddenPromptValues) assert.equal(prompt.includes(value), false, `${role} leaked internal value ${value}`)
  }
  const resultValues: Record<string, unknown> = {
    'final-verdict.json': { schema_version: 'codex-final-verdict-v1', run_id: start.run_id, bundle_hash: manifest.bundle_hash, executive_conclusion: { overall_health: 'INSUFFICIENT_EVIDENCE', most_severe_issue: 'UNKNOWN', confirmed_leakage: false, invalid_strategy_count: 0, locked_test_candidate_count: 0, summary: 'Fixture import validates structure only.' } },
    'final-report.md': '# Fixture Codex result\n\nNo repository claim is confirmed.\n',
    'strategy-verdicts.json': strategies.map((row: any) => ({ run_id: start.run_id, strategy_id: row.strategy_id, verdict: 'INSUFFICIENT_EVIDENCE', confirmed_fatal: 0, confirmed_major: 0, refuted_issues: 0, incomplete_tests: ['fixture'], summary: 'Fixture only.' })),
    'candidate-verdicts.json': candidates.map((row: any) => ({ run_id: start.run_id, candidate_id: row.candidate_id, verdict: 'INSUFFICIENT_EVIDENCE', search_mode: row.search_mode, locked_test_eligible: false, required_tests: ['repository review'] })),
    'issue-verdicts.json': issues.map((row: any) => ({ run_id: start.run_id, issue_id: row.issue_id, verdict: 'UNVERIFIED', severity: row.severity_if_true, evidence_level: 'E1', evidence: [], commands_executed: [], test_results: [], remaining_uncertainty: row.missing_evidence, required_fix: 'Run repository review.', blocks_target: false })),
    'tests-executed.json': [], 'repository-evidence.json': [], 'unresolved-evidence.json': issues.map((row: any) => ({ issue_id: row.issue_id, reason: 'Fixture has no repository adjudication.' })),
    'candidate-recommendations.json': candidates.map((row: any) => ({ candidate_id: row.candidate_id, locked_test_eligible: false, forward_shadow: false, next_step: 'Repository adjudication required.' })),
  }
  const resultEntries: ZipEntryInput[] = REQUIRED_CODEX_OUTPUTS.map((name) => ({ name: `codex-result/${name}`, data: new TextEncoder().encode(typeof resultValues[name] === 'string' ? String(resultValues[name]) : `${JSON.stringify(resultValues[name])}\n`) }))
  const files = Object.fromEntries(await Promise.all(resultEntries.map(async (entry) => [entry.name, await sha256Hex(entry.data)])))
  const resultRoot = { schema_version: 'codex-result-v1', run_id: start.run_id, bundle_hash: manifest.bundle_hash, candidate_hashes: manifest.candidate_hashes,
    generated_at: new Date().toISOString(), final_verdict: (resultValues['final-verdict.json'] as any).executive_conclusion,
    required_files: [...REQUIRED_CODEX_OUTPUTS], files }
  resultEntries.push({ name: 'codex-result/manifest.json', data: new TextEncoder().encode(`${stableStringify({ ...resultRoot, result_hash: await hashJson(resultRoot) })}\n`) })
  const resultZip = createStoredZip(resultEntries)
  const resultBody = new Uint8Array(new ArrayBuffer(resultZip.byteLength)); resultBody.set(resultZip)
  const importKey = `codex-import:${crypto.randomUUID()}`
  const imported = await json(`/runs/${start.run_id}/codex-result`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'Idempotency-Key': importKey }, body: resultBody.buffer })
  assert.equal(imported.status, 'RESULT_READY')
  assert.equal(imported.idempotent_replay, false)
  const importReplay = await json(`/runs/${start.run_id}/codex-result`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'Idempotency-Key': importKey }, body: resultBody.buffer })
  assert.equal(importReplay.idempotent_replay, true)
  const resultDashboard = await json('/dashboard-state')
  assert.equal(resultDashboard.codex_button.state, 'RESULT_READY')
  const conclusion = await json(`/runs/${start.run_id}/codex-conclusion`)
  assert.equal(conclusion.executive_conclusion.invalid_strategy_count, 0)
  assert.equal(conclusion.existing_strategies.length, 13)
  assert.equal(conclusion.new_candidates.length, 12)
  assert.ok(Array.isArray(conclusion.red_team_accuracy))
  assert.ok(Array.isArray(conclusion.tests))
  assert.ok(conclusion.remaining_uncertainty)
  console.log(`strategyDiscoveryLocalE2E.test.ts: PASS ${start.run_id}`)
}

void main()
