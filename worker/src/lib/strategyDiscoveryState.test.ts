import assert from 'node:assert/strict'
import { recoverableLatestRun, resolveButtonState } from '../strategy-discovery/buttonState'
import type { AnalysisRunRecord } from '../strategy-discovery/domain'

const run: AnalysisRunRecord = {
  run_id: 'RUN-1', status: 'RUNNING', idempotency_key: 'I-1', workflow_instance_id: 'W-1', workflow_attempt: 1,
  feature_snapshot_hash: null, strategy_snapshot_hash: null, input_hash: null,
  feature_version: null, strategy_version: null, system_profile_hash: null,
  prompt_set_version: 'p1', schema_set_version: 's1', completed_steps: 7, total_steps: 12,
  current_step: '09_specialist_red_team', blockers: [], warnings: [], fixture_mode: false,
  created_at: '2026-07-11T00:00:00Z', updated_at: '2026-07-11T00:01:00Z', heartbeat_at: '2026-07-11T00:01:00Z',
}

assert.equal(resolveButtonState({ latestRun: null, blockers: [], staleWorkflow: false, bundleReady: false, resultReady: false, artifactMismatch: false }).analysis_button.state, 'READY')
const running = resolveButtonState({ latestRun: run, blockers: [], staleWorkflow: false, bundleReady: false, resultReady: false, artifactMismatch: false })
assert.equal(running.analysis_button.state, 'RUNNING')
assert(running.analysis_button.message.includes('7 / 12'))
assert.equal(running.codex_button.state, 'NOT_READY')
assert.equal(resolveButtonState({ latestRun: { ...run, status: 'FAILED_RECOVERABLE' }, blockers: [], staleWorkflow: false, bundleReady: false, resultReady: false, artifactMismatch: false }).analysis_button.state, 'FAILED_RECOVERABLE')
assert.equal(resolveButtonState({ latestRun: run, blockers: ['Feature Pool 快照不存在'], staleWorkflow: false, bundleReady: false, resultReady: false, artifactMismatch: false }).analysis_button.state, 'BLOCKED')
assert.equal(resolveButtonState({ latestRun: { ...run, status: 'CODEX_HANDOFF_READY' }, blockers: [], staleWorkflow: false, bundleReady: true, resultReady: false, artifactMismatch: false }).codex_button.state, 'HANDOFF_READY')
assert.equal(resolveButtonState({ latestRun: { ...run, status: 'AWAITING_RESULT' }, blockers: [], staleWorkflow: false, bundleReady: true, resultReady: false, artifactMismatch: false }).codex_button.state, 'AWAITING_RESULT')
assert.equal(resolveButtonState({ latestRun: { ...run, status: 'RESULT_READY' }, blockers: [], staleWorkflow: false, bundleReady: true, resultReady: true, artifactMismatch: false }).codex_button.state, 'RESULT_READY')
assert.equal(resolveButtonState({ latestRun: { ...run, status: 'CODEX_HANDOFF_READY' }, blockers: [], staleWorkflow: false, bundleReady: false, resultReady: false, artifactMismatch: true }).analysis_button.state, 'FAILED_RECOVERABLE')
assert.equal(recoverableLatestRun({ analysis_button: { enabled: true, state: 'FAILED_RECOVERABLE', message: 'resume' }, latest_run: run })?.run_id, run.run_id)
assert.equal(recoverableLatestRun({ analysis_button: { enabled: false, state: 'RUNNING', message: 'active' }, latest_run: run }), null)
