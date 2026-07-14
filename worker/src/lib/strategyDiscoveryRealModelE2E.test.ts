import assert from 'node:assert/strict'
import { parseStoredZip } from '../strategy-discovery/zip'

const base = process.argv[2] ?? 'http://127.0.0.1:8799/api'
const deadlineMinutes = Math.max(1, Number(process.argv[3] ?? 20) || 20)
const resumeIdempotencyKey = process.argv[4]
const expectedResumeRunId = process.argv[5]

async function json(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${base}${path}`, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${response.status}:${JSON.stringify(payload)}`)
  return payload
}

async function main() {
  const state = await json('/dashboard-state')
  assert.equal(state.analysis_button.state, resumeIdempotencyKey ? 'FAILED_RECOVERABLE' : 'READY', JSON.stringify(state.blockers))
  const key = resumeIdempotencyKey ?? `real-e2e:${crypto.randomUUID()}`
  const start = await json('/full-analysis', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ fixture_mode: false }) })
  if (resumeIdempotencyKey) {
    assert.equal(start.resume, true)
    assert.equal(start.run_id, expectedResumeRunId)
  }
  const deadline = Date.now() + deadlineMinutes * 60_000
  let status: any
  while (Date.now() < deadline) {
    status = await json(`/runs/${start.run_id}/status`)
    if (['CODEX_HANDOFF_READY', 'FAILED_RECOVERABLE', 'BLOCKED'].includes(status.status)) break
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  assert.equal(status?.status, 'CODEX_HANDOFF_READY', JSON.stringify(status))
  assert.equal(status.fixture_mode, false)
  const report = await json(`/runs/${start.run_id}/report`)
  assert.equal(report.fixture_mode, false)
  assert.ok(report.candidates.every((row: any) => row.source_type === 'REAL'))
  assert.ok(report.hypotheses.every((row: any) => row.source_type === 'REAL'))
  const response = await fetch(`${base}/runs/${start.run_id}/jury-bundle`)
  assert.equal(response.status, 200)
  const files = parseStoredZip(new Uint8Array(await response.arrayBuffer()))
  for (const role of ['FEATURE_LIBRARIAN','HYPOTHESIS_SCIENTIST','REGIME_EXPLORER','EXECUTION_ARCHITECT','PORTFOLIO_JUDGE','DATA_PROSECUTOR','EXECUTION_PROSECUTOR','ECONOMIC_PROSECUTOR','CROSS_EXAMINER']) {
    assert.ok(files.has(`jury-bundle/raw-model-responses/${role}.json`), `missing real response ${role}`)
  }
  console.log(`strategyDiscoveryRealModelE2E.test.ts: PASS ${start.run_id}`)
}

void main()
