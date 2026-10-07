import { inferPipelineChildLog, resolveBusinessDateScopedChainDisplay } from './schedulerStatus'
import type { CronLogEntry } from './schedulerRunLogger'
import assert from 'node:assert/strict'

function parent(summary: string, status: CronLogEntry['status'] = 'triggered'): CronLogEntry[] {
  return [{ task: 'pipeline', status, summary, duration_ms: 120000,
    timestamp: '2026-10-07T15:29:41Z', run_date: '2026-10-07', run_id: 'same-run' }]
}
for (const summary of [
  'dependency=input_prep stage=prep modal_prediction=not_started',
  'dependency=input_snapshot stage=snapshot',
  'pipeline running',
]) {
  for (const child of ['ml-predict', 'recommendation']) {
    assert.equal(inferPipelineChildLog(parent(summary), child), undefined, `${child} must wait during ${summary}`)
  }
}
assert.equal(inferPipelineChildLog(parent('modal_prediction=spawned'), 'ml-predict')?.status, 'running')
assert.equal(inferPipelineChildLog(parent('modal_prediction=spawned'), 'recommendation'), undefined)
assert.equal(inferPipelineChildLog(parent('recommendation_status=running'), 'recommendation')?.status, 'running')
assert.equal(inferPipelineChildLog(parent('preds=692 recos_updated=692', 'success'), 'ml-predict')?.status, 'success')
assert.equal(inferPipelineChildLog(parent('preds=692 recos_updated=692', 'success'), 'recommendation')?.status, 'success')
for (const child of ['ml-predict', 'recommendation']) {
  assert.equal(inferPipelineChildLog(parent('preds=0 recos_updated=0', 'success'), child), undefined)
  assert.equal(inferPipelineChildLog(parent('dependency=input_prep failed', 'error'), child), undefined)
  assert.equal(inferPipelineChildLog(parent('no child evidence', 'success'), child), undefined)
}
assert.equal(inferPipelineChildLog(parent('predictions_written=692', 'success'), 'ml-predict')?.run_id, 'same-run')
console.log('schedulerPipelineChildStatus: passed')

const today = '2026-10-07'
for (const id of ['ml-predict', 'recommendation']) {
  const display = resolveBusinessDateScopedChainDisplay({
    def: { id, group: 'pipeline_chain', chainIndex: 11 }, chainStatusDate: today, today,
    exactLog: inferPipelineChildLog(parent('dependency=input_prep modal_prediction=not_started'), id),
  })
  assert.equal(display?.resolvedDisplay.status, 'waiting')
  assert.equal(display?.resolvedDisplay.statusRunDate, today)
}
