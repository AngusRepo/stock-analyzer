import assert from 'node:assert/strict'
import test from 'node:test'
import { quoteBelongsToSession } from './paperValuationDate'

test('source quote date uses Taiwan timezone, never a fabricated receipt date', () => {
  assert.equal(quoteBelongsToSession('2026-10-14T05:30:00Z', '2026-10-14'), true)
  assert.equal(quoteBelongsToSession('2026-10-14 13:30:00', '2026-10-14'), true)
  assert.equal(quoteBelongsToSession('2026-10-13T16:30:00Z', '2026-10-14'), true)
  for (const time of [undefined, '13:30:00', 'garbage', '2026-10-13T05:30:00Z', '2026-10-15T05:30:00Z'])
    assert.equal(quoteBelongsToSession(time, '2026-10-14'), false)
})
