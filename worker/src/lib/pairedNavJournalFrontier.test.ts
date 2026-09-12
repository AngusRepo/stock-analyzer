import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNavJournalFrontier } from './pairedNavJournalFrontier'

const rows = () => [{ pair_id: 'a', accounted_sessions: 10, last_session_date: '2026-09-21',
  last_journal_checksum: 'a'.repeat(64) }, { pair_id: 'b', accounted_sessions: 0,
  last_session_date: null, last_journal_checksum: null }]

test('frontier includes zero-observation family members and copies original anchors', () => {
  const input = rows()
  const parsed = parseNavJournalFrontier(input, ['b', 'a'], '2026-09-21')
  assert.deepEqual(parsed, input)
  input[0].accounted_sessions = 99
  assert.equal(parsed[0].accounted_sessions, 10)
})

for (const [name, mutate] of [
  ['missing family member', (v: any[]) => v.pop()],
  ['duplicated pair', (v: any[]) => { v[1].pair_id = 'a' }],
  ['wrong member', (v: any[]) => { v[1].pair_id = 'other' }],
  ['negative count', (v: any[]) => { v[0].accounted_sessions = -1 }],
  ['nonintegral count', (v: any[]) => { v[0].accounted_sessions = 1.5 }],
  ['unsafe integer', (v: any[]) => { v[0].accounted_sessions = 2 ** 53 }],
  ['future date', (v: any[]) => { v[0].last_session_date = '2026-09-22' }],
  ['invalid date', (v: any[]) => { v[0].last_session_date = '2026-02-30' }],
  ['missing checksum', (v: any[]) => { v[0].last_journal_checksum = null }],
  ['zero count with a journal', (v: any[]) => { v[1].last_session_date = '2026-09-21' }],
] as const) test(name, () => {
  const value = rows()
  mutate(value)
  assert.throws(() => parseNavJournalFrontier(value, ['a', 'b'], '2026-09-21'), /journal_frontier_/)
})
