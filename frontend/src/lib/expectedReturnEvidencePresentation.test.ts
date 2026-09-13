import assert from 'node:assert/strict'
import test from 'node:test'
import { preoutcomeSummary, navReadinessReason } from './expectedReturnEvidencePresentation'
import type { PipelineMaturityStage } from './pipelineMaturityContract'

function stage(count: unknown = 9, availability = 'available'): PipelineMaturityStage {
  return { id: 'l4', nav_gate: { evaluable_dates: 0 }, progress: { current: 0 }, metrics: [
    { key: 'prospective_evaluable_dates', value: count, availability },
    { key: 'prospective_prediction_max_date', value: '2026-09-04', availability },
  ] } as unknown as PipelineMaturityStage
}

test('preserved nine pre-outcome dates do not claim nine NAV dates or promotion', () => {
  const input = stage()
  const before = structuredClone(input)
  assert.match(preoutcomeSummary(input)!, /已成熟 9 日/)
  assert.match(preoutcomeSummary(input)!, /2026-09-04/)
  assert.match(preoutcomeSummary(input)!, /不換算為 NAV 日數/)
  assert.doesNotMatch(preoutcomeSummary(input)!, /9\/10|PASS/)
  assert.deepEqual(input, before)
  assert.equal(input.nav_gate!.evaluable_dates, 0)
})

test('missing or blocked evidence is unknown, not zero or a recovered nine days', () => {
  for (const availability of ['blocked', 'missing', 'pending', 'not_applicable']) {
    assert.match(preoutcomeSummary(stage(9, availability))!, /尚無可驗證日數/)
    assert.doesNotMatch(preoutcomeSummary(stage(9, availability))!, /2026-09-04|已成熟 9/)
  }
  for (const count of [null, -1, 1.5, NaN, Infinity, '9']) {
    assert.match(preoutcomeSummary(stage(count))!, /尚無可驗證日數/)
  }
  assert.match(preoutcomeSummary(stage(0))!, /已成熟 0 日/)
  assert.equal(preoutcomeSummary({ ...stage(), nav_gate: undefined }), null)
})

test('unregistered NAV is explained as not started, not erased pre-outcome evidence', () => {
  assert.match(navReadinessReason('nav_candidate_not_registered'), /尚未開始配對累積/)
  assert.equal(navReadinessReason('unrecognized_failure'), 'unrecognized_failure')
})
