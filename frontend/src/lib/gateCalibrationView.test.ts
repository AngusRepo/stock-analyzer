import assert from 'node:assert/strict'
import test from 'node:test'
import { gateCalibrationView } from './gateCalibrationView'

test('new Worker payload: four buckets that add up to the total, with the window', () => {
  const view = gateCalibrationView({ days: 7, total_events: 10, filled_events: 1, deferred_events: 5, blocked_events: 3, skipped_events: 1, window_start: '2026-11-19', window_end: '2026-11-25' })
  assert.equal(view.consistent, true)
  assert.deepEqual(view.buckets.map((b) => [b.label, b.value]), [['成交', 1], ['等待', 5], ['擋單', 3], ['略過', 1]])
  assert.equal(view.windowLabel, '11-19～11-25')
})

test('old Worker payload whose buckets miss the total is flagged, not shown as zeros', () => {
  const view = gateCalibrationView({ days: 7, total_events: 4893, filled_events: 0, deferred_events: 0, skipped_events: 0 })
  assert.equal(view.hasBlocked, false)
  assert.equal(view.consistent, false)
  assert.ok(view.buckets.every((b) => b.value === null))
  assert.equal(view.buckets.length, 3)
  assert.equal(view.windowLabel, null)
})

test('old Worker payload that does add up keeps three buckets', () => {
  const view = gateCalibrationView({ total_events: 3, filled_events: 1, deferred_events: 1, skipped_events: 1 })
  assert.equal(view.consistent, true)
  assert.deepEqual(view.buckets.map((b) => b.value), [1, 1, 1])
})

test('denominator definition passes through for the tooltip', () => {
  const view = gateCalibrationView({ total_events: 3, filled_events: 1, deferred_events: 1, blocked_events: 1, skipped_events: 0, cancelled_events: 0, denominator_definition: 'x' })
  assert.equal(view.denominatorDefinition, 'x')
  assert.equal(view.consistent, true, 'cancelled is a subset of skipped and is not added again')
})
