import assert from 'node:assert/strict'
import { resolveExpectedOofCoverageDates } from './expectedReturnServingRegistry'

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