import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  READINESS_STAGES, buildReadinessGates, gaPromotionView, gateStatusFromQuality, readinessStatusFromScheduler, stageFromDefinition,
} from './obsJudgment'
import type { SchedulerJob } from './schedulerJob'

test('OBS readiness: scheduler and data-quality statuses map to the readiness lanes', () => {
  assert.deepEqual(['success', 'running', 'failed', 'error', 'waiting', 'skip', 'sleep', undefined].map(readinessStatusFromScheduler),
    ['ready', 'running', 'blocked', 'blocked', 'waiting', 'pending', 'pending', 'pending'])
  assert.deepEqual(['ok', 'warn', 'fail', 'mystery'].map(gateStatusFromQuality), ['ready', 'waiting', 'blocked', 'pending'])
  const def = READINESS_STAGES.find(stage => stage.id === 'ml-pipeline')!
  const jobs = [{ id: 'pipeline', lastStatus: 'success', summary: '' }, { id: 'recommendation', lastStatus: 'failed', summary: 'l4 failed' }] as SchedulerJob[]
  const stage = stageFromDefinition(def, jobs)
  assert.deepEqual([stage.status, stage.tone, stage.detail, stage.job?.id], ['blocked', 'error', 'l4 failed', 'recommendation'], 'an active failure outranks a success')
})

test('OBS readiness gates: materialization items first, then the fallback checks, then placeholders', () => {
  const materialization = { id: 'market_dashboard_materialization', label: 'M', status: 'warn', summary: '', metrics: { materialization_checks: [
    { key: 'twii_index', label: '加權指數', status: 'ok', rows: 1, latest_date: '2026-11-24', lag_days: 0, required: true, source: 'x', scope: 's', root_cause: null },
    { key: 'put_call_ratio', label: 'PCR', status: 'warn', rows: 2, latest_date: '2026-11-20', lag_days: 4, required: true, source: 'y', scope: 's', root_cause: 'freshness_lag' },
  ] } }
  const gates = buildReadinessGates([materialization] as any)
  assert.deepEqual(gates.map(g => [g.id, g.status, g.detail]), [['twii_index', 'ready', 's / lag 0d'], ['put_call_ratio', 'waiting', 'freshness_lag']])
  const fallback = buildReadinessGates([{ id: 'price_freshness', label: 'Price', status: 'fail', summary: 'stale' }] as any)
  assert.deepEqual(fallback.map(g => [g.id, g.status, g.value]), [['price_freshness', 'blocked', 'FAIL']])
  assert.equal(buildReadinessGates([]).every(g => g.status === 'pending'), true)
})

test('GA promotion display keeps the Sharpe 0.5 / PBO 0.5 / MDD95 0.2 thresholds and the approval boundary', () => {
  const ga = { domain: 'adaptive_meta', source: 'ga_optimizer', severity: 'ok' as const, evidence: {
    best_score: 1.2, best_metrics: { sharpe: 0.49, pbo: 0.5, mdd_95th: 0.2 },
    history_tail: [{ best_score: 1.0 }, { best_score: 1.2 }],
    promotion: { missing_evidence: ['primary_gate'], required_evidence: ['policy_candidate', 'primary_gate'], pending_approval_level: 'l3' },
    failed_gates: ['sharpe_floor'],
  } }
  const view = gaPromotionView([ga])
  const tone = Object.fromEntries(view.metrics.map(m => [m.label, m.tone]))
  assert.deepEqual([tone.Sharpe, tone.PBO, tone.MDD95, tone['Best score']], ['warn', 'error', 'ok', 'ok'])
  assert.equal(view.metrics[0].delta, '+0.2000')
  assert.equal(view.pendingApprovalLevel, 'L3')
  assert.equal(view.tone, 'warn', 'a pending approval outranks failed gates in the review tone')
  assert.deepEqual(view.blockers, ['primary_gate / sharpe_floor'])
  assert.deepEqual(view.gates.map(g => [g.label, g.status]),
    [['policy_candidate', 'pass'], ['primary_gate / sharpe_floor', 'fail'], ['Wei approval boundary', 'warn']])
  const blocked = gaPromotionView([{ ...ga, evidence: { ...ga.evidence, validation: { status: 'infra_blocked', reason: '回測資料未就緒' } } }])
  assert.deepEqual(blocked.blockers, ['回測資料未就緒'])
  assert.ok(blocked.gates.some(g => g.label === '驗證資料未就緒' && g.status === 'missing'))
})
