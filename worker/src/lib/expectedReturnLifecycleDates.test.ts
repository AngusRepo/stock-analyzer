import assert from 'node:assert/strict'
import {
  isExpectedOofCurrentCloseCovered,
  resolveExpectedOofCoverageDates,
  resolveLegalForwardNotEvaluableDates,
} from './expectedReturnServingRegistry'

const dates = [
  '2026-07-22',
  '2026-07-23',
  '2026-07-24',
  '2026-07-27',
  '2026-07-28',
  '2026-07-29',
  '2026-07-30',
]

assert.deepEqual(resolveExpectedOofCoverageDates(dates), {
  requiredOofMaxDate: '2026-07-22',
  newlyMatureSignalDate: '2026-07-23',
})
assert.equal(resolveExpectedOofCoverageDates(dates.slice(1)), null)
assert.deepEqual(resolveExpectedOofCoverageDates([...dates].reverse()), {
  requiredOofMaxDate: '2026-07-22',
  newlyMatureSignalDate: '2026-07-23',
})

const legalNotEvaluable = resolveLegalForwardNotEvaluableDates(JSON.stringify({
  not_evaluable: [
    { date: '2026-08-11', reason: 'missing_native_pit_components' },
    { date: '2026-08-12', reason: 'unapproved_reason' },
  ],
}))
assert.deepEqual(legalNotEvaluable, ['2026-08-11'])
assert.equal(isExpectedOofCurrentCloseCovered('2026-08-10', '2026-08-11', legalNotEvaluable), true)
assert.equal(isExpectedOofCurrentCloseCovered('2026-08-10', '2026-08-12', legalNotEvaluable), false)
assert.equal(isExpectedOofCurrentCloseCovered('2026-08-12', '2026-08-12', []), true)
assert.deepEqual(resolveLegalForwardNotEvaluableDates('{broken'), [])
