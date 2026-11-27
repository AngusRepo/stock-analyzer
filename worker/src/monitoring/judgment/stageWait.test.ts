import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chainStageWaitSummary } from '../../lib/opsChainStageState'
import { stageWait } from './stageWait'

// Parity: what the writer stores (opsChainStageState chainStageWaitSummary) is what the reader parses.
const STORED_AT = Date.parse('2026-11-24T00:00:00Z')
const DISPATCH = '2026-11-24T14:20:00+08:00'
const DISPATCH_Z = '2026-11-24T06:20:00.000Z'
const read = (summary: string | undefined, nowMs: number, status = 'running') => stageWait({ status, summary: summary ?? null }, nowMs)

test('stageWait reads exactly what chainStageWaitSummary writes', () => {
  const parked = chainStageWaitSummary({ status: 'waiting', summary: 'Serving published; research waits', wait_until: DISPATCH }, STORED_AT)
  assert.deepEqual(read(parked, STORED_AT), { waiting: true, wait_until: DISPATCH_Z })
  // Past the dispatch: no longer waiting, the wait_until stays for the stall clock.
  assert.deepEqual(read(parked, Date.parse(DISPATCH_Z) + 1), { waiting: false, wait_until: DISPATCH_Z })
  // A stored wait whose wait_until had already passed when written still carries it: not waiting.
  const late = chainStageWaitSummary({ status: 'waiting', summary: 'x', wait_until: DISPATCH }, Date.parse(DISPATCH_Z) + 60_000)
  assert.deepEqual(read(late, Date.parse(DISPATCH_Z) + 60_000), { waiting: false, wait_until: DISPATCH_Z })
  // Open-ended waits (no wait_until: FinLab late lane, allocator EV deferrals) and an already-prefixed summary.
  assert.deepEqual(read(chainStageWaitSummary({ status: 'waiting', summary: 'status=waiting awaiting_late_lane fields=a' }, STORED_AT), STORED_AT),
    { waiting: true, wait_until: null })
  assert.deepEqual(read(chainStageWaitSummary({ status: 'waiting' }, STORED_AT), STORED_AT), { waiting: true, wait_until: null })
  // The evening root's form: running with a wait_until ahead.
  assert.deepEqual(read(chainStageWaitSummary({ status: 'running', summary: 'root', wait_until: DISPATCH }, STORED_AT), STORED_AT),
    { waiting: true, wait_until: DISPATCH_Z })
  // Not a wait: an ordinary running summary, or a terminal row.
  assert.deepEqual(read(chainStageWaitSummary({ status: 'running', summary: 'running phase=x' }, STORED_AT), STORED_AT), { waiting: false, wait_until: null })
  assert.deepEqual(read(parked, STORED_AT, 'success'), { waiting: false, wait_until: null })
})

test('rows written before the prefix: the after-close dispatch phrase with its Taiwan time', () => {
  const legacy = 'Serving published; research and verification wait for the after-close dispatch at 2026-11-24 14:20 run_id=r'
  assert.deepEqual(read(legacy, STORED_AT), { waiting: true, wait_until: DISPATCH_Z })
  assert.deepEqual(read('research waits for the after-close dispatch run_id=r', STORED_AT), { waiting: false, wait_until: null }, 'no time: not read as a wait')
})
