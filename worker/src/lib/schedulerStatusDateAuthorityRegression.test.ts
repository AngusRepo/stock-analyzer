import assert from 'node:assert/strict'
import { selectSchedulerChainDates } from './schedulerStatus'

const selection = selectSchedulerChainDates(
  ['2026-07-29', '2026-07-28'],
  {
    '2026-07-29': [
      {
        task: 'evening-chain',
        status: 'success',
        summary: 'root callback closed after midnight',
        duration_ms: 10,
        run_date: '2026-07-29',
        timestamp: '2026-07-30T00:08:00.000+08:00',
      },
      {
        task: 'allocator-ev-readiness',
        status: 'error',
        summary: 'child evidence failed before root recovery',
        duration_ms: 10,
        run_date: '2026-07-29',
        timestamp: '2026-07-29T22:00:00.000+08:00',
      },
    ],
    '2026-07-28': [{
      task: 'evening-chain',
      status: 'success',
      summary: 'older chain',
      duration_ms: 10,
      run_date: '2026-07-28',
      timestamp: '2026-07-28T23:00:00.000+08:00',
    }],
  },
)

assert.equal(selection.activeChainDate, null)
assert.equal(selection.chainStatusDate, '2026-07-29')

const active = selectSchedulerChainDates(
  ['2026-07-30', '2026-07-29'],
  {
    '2026-07-30': [{ task: 'evening-chain', status: 'running', summary: 'active', duration_ms: 0, timestamp: '2026-07-30T21:00:00+08:00' }],
    '2026-07-29': [{ task: 'evening-chain', status: 'success', summary: 'closed', duration_ms: 0, timestamp: '2026-07-30T00:08:00+08:00' }],
  },
)
assert.equal(active.activeChainDate, '2026-07-30')
assert.equal(active.chainStatusDate, '2026-07-30')
