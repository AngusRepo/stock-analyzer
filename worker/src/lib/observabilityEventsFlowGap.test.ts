import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEventsFromAdaptiveMeta, buildEventsFromScheduler } from './observabilityEvents'

// FG-10: OBS must not call the scheduler stable or adaptive meta healthy while work is stuck or frozen.
const generatedAt = '2026-11-02T07:30:00.000Z'
const job = (id: string, lastStatus: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, group: 'pipeline_chain', lastStatus, summary: `${id} summary`, ...extra,
})

test('U13: blocked, long-waiting and should-have-run skips are actionable scheduler events', () => {
  const events = buildEventsFromScheduler({
    generatedAt,
    jobs: [
      job('update', 'blocked', { statusRunDate: '2026-10-30' }),
      job('verify-v2', 'waiting', { statusRunDate: '2026-10-28' }),
      job('post-verify-chain', 'waiting', { statusRunDate: '2026-10-30' }),
      job('adapt', 'skip', { statusRunDate: '2026-10-30', attentionReason: 'live-canonical task did not run: run_date=2026-10-30' }),
      job('rescore-10', 'skip', { attentionReason: null }),
      job('weekly-audit', 'success'),
    ],
  })
  const byId = new Map(events.map((event) => [String(event.evidence.task_id), event]))
  assert.ok(!events.some((event) => event.title === 'Scheduler stable'))
  assert.equal(byId.get('update')?.severity, 'warn')
  assert.equal(byId.get('verify-v2')?.severity, 'warn', 'waiting on a run_date older than the previous weekday is long-waiting')
  assert.ok(!byId.has('post-verify-chain'), 'Friday work still waiting on Monday is the normal post-close cadence')
  assert.equal(byId.get('adapt')?.severity, 'warn')
  assert.match(byId.get('adapt')!.summary, /live-canonical task did not run/)
  assert.ok(!byId.has('rescore-10') && !byId.has('weekly-audit'))
})

test('U14: adaptive meta warns when computed_at is stale or missing', () => {
  const params = (computedAt?: string) => ({
    computed_at: computedAt,
    provenance: { source: 'risk-assess', fallback: false, regime: 'volatile' },
    meta_layer: { alpha_vote_models: ['LightGBM'], state_space_overlays: ['KalmanFilter'] },
  })
  const stale = buildEventsFromAdaptiveMeta({ generatedAt, params: params('2026-10-07T08:02+08:00') })[0]
  assert.equal(stale.severity, 'warn')
  assert.equal(stale.status, 'stale')
  assert.match(stale.summary, /computed_at=2026-10-07T08:02\+08:00/)
  assert.equal(buildEventsFromAdaptiveMeta({ generatedAt, params: params() })[0].severity, 'warn')
  assert.equal(buildEventsFromAdaptiveMeta({ generatedAt, params: params('2026-11-01T08:02+08:00') })[0].severity, 'ok')
})
