import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAPPED_JOB_IDS, SCOPES, STAGES, buildScopedJobMap, connectorStatus, currentStage, duplicateScopeJobIds,
  inferOrchestratorStage, scopeById, scopeDisplayStageIds, scopeExecutionStageIds, scopeProgress, statusLabel,
  visualStatus,
} from './executionChainDag'
import { FINLAB_STAGE_CARDS } from './finlabStageCards'
import { PIPELINE_STAGE_CARDS } from './pipelineStageCards'
import type { SchedulerJob } from './schedulerJob'

// The frontend panel has no tests for its DAG and classification; these pin the copied behavior.
const job = (id: string, lastStatus: SchedulerJob['lastStatus'], extra: Partial<SchedulerJob> = {}) =>
  ({ id, name: id, lastStatus, summary: '', ...extra }) as SchedulerJob

test('topology: every scoped stage is defined, owned by one cadence scope, and the daily lane expands its cards', () => {
  assert.deepEqual(duplicateScopeJobIds(SCOPES), [])
  for (const scope of SCOPES) for (const id of scopeExecutionStageIds(scope)) assert.ok(STAGES[id], `${scope.id}: ${id} has no stage definition`)
  const daily = scopeById('daily_readiness')
  assert.equal(daily.orchestratorId, 'evening-chain')
  assert.equal(daily.columns[0][0], 'market-close-refresh', 'the chain root stage the missed rule watches')
  const ids = scopeDisplayStageIds(daily)
  assert.ok(!ids.includes('finlab-v4-backfill') && !ids.includes('pipeline') && !ids.includes('ml-predict'))
  for (const card of [...FINLAB_STAGE_CARDS, ...PIPELINE_STAGE_CARDS]) assert.ok(ids.includes(card.id), card.id)
  assert.equal(ids.length, new Set(ids).size)
  assert.ok(ids.indexOf('finlab-publish') < ids.indexOf('update') && ids.indexOf('pipeline-l3') < ids.indexOf('post-pipeline-chain'))
  assert.ok(MAPPED_JOB_IDS.has('evening-chain') && MAPPED_JOB_IDS.has('monthly-readiness'))
  assert.ok(STAGES['finlab-backfill-watchdog'].optional && !STAGES['market-close-refresh'].optional)
  assert.equal(STAGES['evening-closure'].dependsOn, 'strategy-learning')
})

test('visualStatus: receipts map to the panel classification, special no-ops before failures', () => {
  assert.equal(visualStatus(undefined), 'not_started')
  assert.equal(visualStatus(job('x', 'running', { stageVisualStatus: 'stale' })), 'stale', 'stage cards keep their own status')
  assert.equal(visualStatus(job('x', 'success')), 'completed')
  assert.equal(visualStatus(job('x', 'skip', { attentionReason: 'should have run' })), 'attention')
  assert.equal(visualStatus(job('allocator-ev-readiness', 'failed', { lastError: 'expected_return_serving_state=no_eligible_owner' })), 'noop')
  assert.equal(visualStatus(job('allocator-ev-readiness', 'failed', { lastError: 'boom' })), 'blocked')
  assert.equal(visualStatus(job('verify-v2', 'skip', { summary: 'pending predictions do not yet have five stock-specific trading sessions; verified=0' })), 'noop')
  assert.equal(visualStatus(job('allocator-ev-feature-snapshot-backfill', 'skip',
    { summary: 'not applicable: Active8 evidence-only authority attested actionable=0 production_effect=0' })), 'noop')
  assert.equal(visualStatus(job('intraday-check', 'skip')), 'noop')
  assert.equal(visualStatus(job('update', 'skip')), 'skipped')
  assert.equal(visualStatus(job('x', 'failed')), 'blocked')
  assert.equal(visualStatus(job('x', 'blocked')), 'blocked')
  assert.equal(visualStatus(job('x', 'sleep')), 'out_of_window')
  assert.equal(visualStatus(job('x', 'waiting')), 'waiting')
})

test('statusLabel: blocked, closure, recovered replay and safe abstention wording', () => {
  assert.equal(statusLabel(job('update', 'blocked')), '上游阻擋 · 未執行')
  assert.equal(statusLabel(job('evening-closure', 'blocked')), '全鏈中止')
  assert.equal(statusLabel(job('x', 'success', { recoveredFromStatus: 'failed', statusScope: 'historical_replay', statusRunDate: '2026-11-03' })),
    'Historical replay · 11/3 · Recovered')
  assert.equal(statusLabel(job('x', 'running', { statusScope: 'historical_replay', statusRunDate: '2026-11-03' })), 'Historical replay · 11/3 · Running')
  assert.equal(statusLabel(job('allocator-ev-readiness', 'failed', { lastError: 'no_validated_expected_return_lane' })), 'Checked · safe abstention')
  assert.equal(statusLabel(job('verify-v2', 'skip', { summary: 'pending predictions do not yet have five stock-specific trading sessions verified=0' })),
    'Checked · awaiting maturity')
  assert.equal(statusLabel(job('finlab-acquire', 'waiting', { finlabPhase: 'acquire', summary: '無階段紀錄；不能由總狀態推定' })), '無階段紀錄')
})

test('inferOrchestratorStage: specific hints win over their substrings', () => {
  assert.equal(inferOrchestratorStage('running strategy-learning-mature-evidence'), 'strategy-learning-mature-evidence')
  assert.equal(inferOrchestratorStage('strategy-learning queued'), 'strategy-learning')
  assert.equal(inferOrchestratorStage('post-verify callback'), 'post-verify-chain')
  assert.equal(inferOrchestratorStage('verify running'), 'verify-v2')
  assert.equal(inferOrchestratorStage('snapshot callback after pipeline'), 'post-pipeline-chain')
  assert.equal(inferOrchestratorStage('pipeline dispatched'), 'pipeline')
  assert.equal(inferOrchestratorStage('FinLab canonical wait'), 'finlab-v4-backfill')
  assert.equal(inferOrchestratorStage('  '), null)
  assert.equal(inferOrchestratorStage('unrelated'), null)
})

test('connectorStatus: blocked and running dominate; all-skipped columns completed nothing', () => {
  assert.equal(connectorStatus([job('a', 'failed')], [job('b', 'running')]), 'blocked')
  assert.equal(connectorStatus([job('a', 'success')], [job('b', 'running')]), 'running')
  assert.equal(connectorStatus([job('a', 'skip', { attentionReason: 'r' })], []), 'attention')
  assert.equal(connectorStatus([job('a', 'skip'), job('b', 'skip')], []), 'skipped')
  assert.equal(connectorStatus([job('a', 'success'), job('b', 'skip')], []), 'completed')
  assert.equal(connectorStatus([job('a', 'waiting')], [job('b', 'waiting')]), 'waiting')
  assert.equal(connectorStatus([undefined], [undefined]), 'not_started')
})

test('buildScopedJobMap: callback-owned closure waits on its running upstream; current stage and progress', () => {
  const daily = scopeById('daily_readiness')
  const jobs = new Map<string, SchedulerJob>([
    ['market-close-refresh', job('market-close-refresh', 'success')],
    ['update', job('update', 'running', { statusRunDate: '2026-11-24' })],
    ['strategy-learning', job('strategy-learning', 'running')],
    ['evening-closure', job('evening-closure', 'sleep')],
  ])
  const scoped = buildScopedJobMap(jobs, daily, Date.parse('2026-11-24T12:00:00Z'))
  assert.equal(scoped.get('update')?.lastStatus, 'running')
  const current = currentStage(scoped, daily)
  assert.equal(current.cue, 'Running now')
  assert.ok(['update', 'strategy-learning'].includes(current.id))
  const progress = scopeProgress(scoped, daily)
  assert.equal(progress.total, daily.columns.flat().flatMap(id => id === 'finlab-v4-backfill' ? FINLAB_STAGE_CARDS.map(c => c.id)
    : id === 'pipeline' ? PIPELINE_STAGE_CARDS.map(c => c.id) : id === 'ml-predict' ? [] : [id]).length, 'missing receipts stay in the denominator')
  assert.equal(progress.completed, 1)
  // dependsOn: a sleeping callback-owned stage waits while its upstream owner is not complete (a failed upstream
  // is not a running attempt, so the attempt-aware replay leaves it alone). Weekly scope: no closure rewrite.
  const weekly = { ...scopeById('weekly'), columns: [['strategy-learning'], ['evening-closure']] }
  const waiting = buildScopedJobMap(new Map([['strategy-learning', job('strategy-learning', 'failed')], ['evening-closure', job('evening-closure', 'sleep')]]), weekly)
  assert.equal(waiting.get('evening-closure')?.lastStatus, 'waiting')
  assert.equal(waiting.get('evening-closure')?.summary, 'Waiting for strategy-learning terminal callback')
  const idle = currentStage(new Map([['market-close-refresh', job('market-close-refresh', 'success')]]), daily)
  assert.deepEqual([idle.id, idle.cue], ['market-close-refresh', 'No active runtime · latest checkpoint'])
})
