import assert from 'node:assert/strict'
import { inspectExpectedReturnCandidateEvidence } from './expectedReturnCandidateEvidence'

void (async () => {
  const rows = new Map<string, Record<string, unknown> | null>([
    ['l4_alpha_ev_refresh', {
      artifact_id: 'l4:test',
      version: 'l4-v4-test',
      candidate_type: 'l4_alpha_ev_refresh',
      state: 'offline_failed',
      source_run_date: '2026-07-09',
      offline_gate_decision: 'FAIL',
      offline_gate_failed_gates: JSON.stringify(['date_clustered_lcb_non_positive']),
      offline_evidence_json: JSON.stringify({ rows_loaded: 1200, end_date: '2026-07-09' }),
      live_gate_status: 'not_started',
      live_evidence_json: '{}',
      updated_at: '2026-07-26T00:00:00Z',
    }],
    ['allocator_ev_fusion_refresh', null],
  ])
  const db = {
    prepare: () => ({
      bind: (_owner: string, candidateType: string) => ({
        first: async () => rows.get(candidateType) ?? null,
      }),
    }),
  } as any

  const report = await inspectExpectedReturnCandidateEvidence(db)
  assert.equal(report.candidates.l4_alpha_ev.resolution, 'candidate_failed_validation')
  assert.deepEqual(report.candidates.l4_alpha_ev.failed_gates, ['date_clustered_lcb_non_positive'])
  assert.equal(report.candidates.l4_alpha_ev.rows_loaded, 1200)
  assert.equal(report.candidates.allocator_ev_fusion.resolution, 'true_missing')
})().catch((error) => {
  throw error
})
