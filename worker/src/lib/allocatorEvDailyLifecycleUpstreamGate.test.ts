import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateAllocatorEvRecoveryUpstreamGate } from './allocatorEvDailyLifecycle'

const runId = 'pipeline-v2-current'
const completeSummary = `run_id=${runId} symbols=83/83 rows=664 models=8 `
  + 'incomplete_active_model_symbols=0 symbol_closure=True active_model_closure=True'

test('watchdog accepts one canonical successful pipeline/ML run while root remains running', () => {
  const gate = evaluateAllocatorEvRecoveryUpstreamGate({
    root: { status: 'running', summary: 'post-pipeline continuation running', run_id: runId },
    pipeline: { status: 'success', summary: 'pipeline completed', run_id: runId },
    mlPredict: { status: 'success', summary: completeSummary, run_id: runId },
  })

  assert.equal(gate.ready, true)
  assert.deepEqual(gate.blockers, [])
})

test('watchdog blocks a pipeline-terminal root failure even when partial rows exist', () => {
  const gate = evaluateAllocatorEvRecoveryUpstreamGate({
    root: {
      status: 'error',
      summary: 'root chain stopped at pipeline callback: active_model_symbol_closure_failed:count=49',
      run_id: runId,
    },
    pipeline: { status: 'error', summary: 'active_model_symbol_closure_failed:count=49', run_id: runId },
    mlPredict: {
      status: 'error',
      summary: `run_id=${runId} active_model_closure=False`,
      run_id: runId,
    },
  })

  assert.equal(gate.ready, false)
  assert(gate.blockers.includes('pipeline_terminal_not_success:error'))
  assert(gate.blockers.includes('ml_predict_terminal_not_success:error'))
  assert(gate.blockers.includes('active_model_closure_not_proven'))
  assert(gate.blockers.includes('root_pipeline_terminal_error:error'))
})

test('watchdog rejects stale ML success from a different pipeline run', () => {
  const gate = evaluateAllocatorEvRecoveryUpstreamGate({
    root: { status: 'running', summary: 'new run active', run_id: runId },
    pipeline: { status: 'success', summary: 'pipeline completed', run_id: runId },
    mlPredict: {
      status: 'success',
      summary: completeSummary.replace(runId, 'pipeline-v2-stale'),
      run_id: 'pipeline-v2-stale',
    },
  })

  assert.equal(gate.ready, false)
  assert(gate.blockers.some((blocker) => blocker.startsWith('pipeline_ml_run_id_mismatch:')))
})

test('watchdog rejects matching stale pipeline and ML evidence under a newer root run', () => {
  const staleRunId = 'pipeline-v2-stale'
  const gate = evaluateAllocatorEvRecoveryUpstreamGate({
    root: { status: 'running', summary: 'new run active', run_id: runId },
    pipeline: { status: 'success', summary: 'stale pipeline completed', run_id: staleRunId },
    mlPredict: {
      status: 'success',
      summary: completeSummary.replace(runId, staleRunId),
      run_id: staleRunId,
    },
  })

  assert.equal(gate.ready, false)
  assert(gate.blockers.some((blocker) => blocker.startsWith('root_pipeline_run_id_mismatch:')))
  assert(gate.blockers.some((blocker) => blocker.startsWith('root_ml_run_id_mismatch:')))
})

test('watchdog requires an explicit canonical root run id', () => {
  const gate = evaluateAllocatorEvRecoveryUpstreamGate({
    root: { status: 'running', summary: 'root callback lacks lineage' },
    pipeline: { status: 'success', summary: 'pipeline completed', run_id: runId },
    mlPredict: { status: 'success', summary: completeSummary, run_id: runId },
  })

  assert.equal(gate.ready, false)
  assert(gate.blockers.includes('root_run_id_missing'))
})

test('watchdog can recover a downstream root error after upstream closure passed', () => {
  const gate = evaluateAllocatorEvRecoveryUpstreamGate({
    root: {
      status: 'error',
      summary: 'root chain stopped in post-pipeline callback chain: allocator snapshot readback incomplete',
      run_id: runId,
    },
    pipeline: { status: 'success', summary: 'pipeline completed', run_id: runId },
    mlPredict: { status: 'success', summary: completeSummary, run_id: runId },
  })

  assert.equal(gate.ready, true)
  assert.deepEqual(gate.blockers, [])
})
