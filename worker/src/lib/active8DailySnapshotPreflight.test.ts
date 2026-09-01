import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessActive8DailySnapshotPreflight,
  assessActive8DailyTerminalFence,
} from './controllerResearchWorkflows'

const marketRows = [
  { trading_date: '2026-08-18', price_rows: 1000 },
  { trading_date: '2026-08-19', price_rows: 1010 },
  { trading_date: '2026-08-20', price_rows: 990 },
  { trading_date: '2026-08-21', price_rows: 1020 },
  { trading_date: '2026-08-22', price_rows: 3 },
]

test('daily Active-8 preflight rejects a compute snapshot behind the latest covered market session', () => {
  const result = assessActive8DailySnapshotPreflight('2026-08-22', marketRows, {
    snapshot_id: 'backtest:2026-08-20',
    business_date: '2026-08-20',
  })
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'compute_snapshot_behind_market_session')
  assert.equal(result.expected_business_date, '2026-08-21')
  assert.equal(result.snapshot_business_date, '2026-08-20')
})

test('daily Active-8 preflight admits an exact compute snapshot and ignores a thin partial day', () => {
  const result = assessActive8DailySnapshotPreflight('2026-08-22', marketRows, {
    snapshot_id: 'backtest:2026-08-21',
    business_date: '2026-08-21',
    metadata_json: JSON.stringify({ start_date: '2025-04-04' }),
  })
  assert.equal(result.ready, true)
  assert.equal(result.reason, 'ready')
  assert.equal(result.expected_business_date, '2026-08-21')
})

test('daily Active-8 preflight rejects an exact-date snapshot with insufficient history', () => {
  const result = assessActive8DailySnapshotPreflight('2026-08-22', marketRows, {
    snapshot_id: 'backtest:2026-08-21:short',
    business_date: '2026-08-21',
    metadata_json: JSON.stringify({ start_date: '2026-07-22' }),
  })
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'compute_snapshot_history_insufficient')
  assert.equal(result.snapshot_minimum_start_date, '2025-04-04')
})

test('daily Active-8 preflight fails closed when the compute snapshot is missing', () => {
  const result = assessActive8DailySnapshotPreflight('2026-08-22', marketRows, null)
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'exact_compute_snapshot_missing')
})

const readyPreflight = assessActive8DailySnapshotPreflight('2026-09-01', [
  { trading_date: '2026-08-28', price_rows: 1940 },
  { trading_date: '2026-08-31', price_rows: 1950 },
], {
  snapshot_id: 'backtest_dataset:2026-08-31:run-1:snapshot',
  business_date: '2026-08-31',
  metadata_json: JSON.stringify({ start_date: '2025-04-14' }),
})

test('daily Active-8 terminal fence closes only the exact ready snapshot ticket', () => {
  const result = assessActive8DailyTerminalFence(readyPreflight, {
    status: 'success',
    business_date: '2026-08-31',
    metadata_json: JSON.stringify({
      origin: 'dataset_snapshot_ready',
      snapshot_id: 'backtest_dataset:2026-08-31:run-1:snapshot',
    }),
  })
  assert.deepEqual(result, { closed: true, reason: 'exact_snapshot_terminal_success' })
})

test('daily Active-8 terminal fence does not hide a failed ticket', () => {
  const result = assessActive8DailyTerminalFence(readyPreflight, {
    status: 'error',
    business_date: '2026-08-31',
    metadata_json: JSON.stringify({
      origin: 'dataset_snapshot_ready',
      snapshot_id: 'backtest_dataset:2026-08-31:run-1:snapshot',
    }),
  })
  assert.equal(result.closed, false)
  assert.equal(result.reason, 'terminal_ticket_error')
})

test('daily Active-8 terminal fence rejects a different snapshot identity', () => {
  const result = assessActive8DailyTerminalFence(readyPreflight, {
    status: 'success',
    business_date: '2026-08-31',
    metadata_json: JSON.stringify({
      origin: 'dataset_snapshot_ready',
      snapshot_id: 'backtest_dataset:2026-08-31:other-run:snapshot',
    }),
  })
  assert.equal(result.closed, false)
  assert.equal(result.reason, 'terminal_ticket_snapshot_mismatch')
})

test('daily Active-8 terminal fence fails open to real work when no ticket exists', () => {
  const result = assessActive8DailyTerminalFence(readyPreflight, null)
  assert.deepEqual(result, { closed: false, reason: 'terminal_ticket_missing' })
})
