import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { PAPER_GATE_CHECKS_SQL, PAPER_GATE_FILLED_SQL, buildPaperGateCalibration, gateWindowUtcBounds } from './paperGateCalibration'

function sqliteD1(sql: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let args: unknown[] = []
      const stmt = {
        bind(...values: unknown[]) { args = values; return stmt },
        async all() { return { results: sql.prepare(query).all(...(args as any[])) } },
        async first() { return sql.prepare(query).get(...(args as any[])) ?? null },
      }
      return stmt
    },
  } as unknown as D1Database
}

function openPaper(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync('domain-schemas/paper.sql', 'utf8'))
  return db
}

test('one outcome per check, filled from paper_orders, and the four outcomes sum to total', async () => {
  const sql = openPaper()
  try {
    sql.exec('INSERT INTO paper_accounts(id) VALUES (1), (2)')
    const event = sql.prepare(`INSERT INTO paper_execution_events(account_id, trade_date, symbol, event_type, status, reason, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'intraday_check', ?)`)
    // Check 1 (2330, 01:15): technical defer + pending_buy checked_waiting -> 1 deferred.
    event.run(1, '2026-11-25', '2330', 'intraday_technical_decision', 'defer', 'swing_waiting_next_bar', '2026-11-25 01:15:02')
    event.run(1, '2026-11-25', '2330', 'pending_buy', 'checked_waiting', 'swing_waiting_next_bar', '2026-11-25 01:15:02')
    // Check 2 (2317, 01:15): technical defer + checked_waiting + execution_blocked companion -> 1 blocked.
    event.run(1, '2026-11-25', '2317', 'intraday_technical_decision', 'defer', 'swing_recovery_expired', '2026-11-25 01:15:03')
    event.run(1, '2026-11-25', '2317', 'pending_buy', 'checked_waiting', 'swing_recovery_expired', '2026-11-25 01:15:03')
    event.run(1, '2026-11-25', '2317', 'pending_buy', 'execution_blocked', 'swing_recovery_expired', '2026-11-25 01:15:03')
    // Check 3 (2317, 01:16): quote_unavailable + companion -> 1 blocked.
    event.run(1, '2026-11-25', '2317', 'pending_buy', 'quote_unavailable', 'shioaji_quote_missing', '2026-11-25 01:16:00')
    event.run(1, '2026-11-25', '2317', 'pending_buy', 'execution_blocked', 'shioaji_quote_missing', '2026-11-25T01:16:01Z')
    // Check 4 (2454): allocator skip -> skipped; check 5 (2603): cancelled -> skipped.
    event.run(1, '2026-11-24', '2454', 'pending_buy', 'allocator_skip', 'l4_hard_risk_veto', '2026-11-24 02:00:00')
    event.run(1, '2026-11-24', '2603', 'pending_buy', 'cancelled', 'pending_expired', '2026-11-24 05:30:00')
    // Terminal gate skip (restricted execution) -> skipped; 'expired' is not counted yet.
    event.run(1, '2026-11-24', '3008', 'pending_buy', 'skipped', 'restricted_execution_gate', '2026-11-24 02:10:00')
    event.run(1, '2026-11-24', '3008', 'pending_buy', 'expired', 'pending_expired', '2026-11-24 05:31:00')
    // Check 6 (1101): primary and companion straddle a minute -> still 1 blocked.
    event.run(1, '2026-11-25', '1101', 'pending_buy', 'checked_waiting', 'swing_market_below_ma60', '2026-11-25 01:16:59')
    event.run(1, '2026-11-25', '1101', 'pending_buy', 'execution_blocked', 'swing_market_below_ma60', '2026-11-25 01:17:00')
    // Checks 7 and 8 (1216): two separate checks in the same minute -> 2 deferred.
    event.run(1, '2026-11-25', '1216', 'pending_buy', 'checked_waiting', 'swing_waiting_next_bar', '2026-11-25 01:18:01')
    event.run(1, '2026-11-25', '1216', 'pending_buy', 'checked_waiting', 'swing_waiting_next_bar', '2026-11-25 01:18:40')
    // Check 9 (2412): checked_waiting, then a submitted note with the same reason and the submitted
    // note's own companion -> the checked_waiting stays deferred.
    event.run(1, '2026-11-25', '2412', 'pending_buy', 'checked_waiting', 'swing_breakout_confirmed', '2026-11-25 01:19:00')
    event.run(1, '2026-11-25', '2412', 'pending_buy', 'submitted', 'swing_breakout_confirmed', '2026-11-25 01:19:01')
    event.run(1, '2026-11-25', '2412', 'pending_buy', 'execution_blocked', 'swing_breakout_confirmed', '2026-11-25 01:19:01')
    // A companion of another symbol or reason does not mark a check blocked.
    event.run(1, '2026-11-25', '2603', 'pending_buy', 'execution_blocked', 'other_reason', '2026-11-25 01:18:41')
    // Not gate outcomes / out of scope: lifecycle note, audit rows, other account, outside the window.
    event.run(1, '2026-11-25', '2330', 'pending_buy', 'submitted', 'order_sent', '2026-11-25 01:20:00')
    event.run(1, '2026-11-25', null, 'snapshot_audit', 'warn', 'benchmark_mark_missing', '2026-11-25 06:00:00')
    event.run(2, '2026-11-25', '2330', 'pending_buy', 'checked_waiting', 'x', '2026-11-25 01:15:00')
    event.run(1, '2026-11-18', '2330', 'pending_buy', 'checked_waiting', 'x', '2026-11-18 01:15:00')
    const order = sql.prepare(`INSERT INTO paper_orders(account_id, symbol, side, shares, price, total_cost, source, created_at) VALUES (?, ?, ?, 1000, 10, 10000, ?, ?)`)
    order.run(1, '2330', 'buy', 'auto_ml', '2026-11-25 01:20:05')
    order.run(1, '2330', 'buy', 'auto_ml', '2026-11-18T16:30:00Z') // 2026-11-19 00:30 TW: inside the window
    order.run(1, '2330', 'buy', 'auto_ml', '2026-11-18T15:59:59Z') // 2026-11-18 TW: outside
    order.run(1, '2330', 'sell', 'auto_ml', '2026-11-25 02:00:00')
    order.run(2, '2330', 'buy', 'auto_ml', '2026-11-25 02:00:00')
    // Manual POST /api/paper/buy orders never passed the gate.
    order.run(1, '2454', 'buy', 'manual', '2026-11-25 03:00:00')

    const result = await buildPaperGateCalibration(sqliteD1(sql), { accountId: 1, days: 7, windowStart: '2026-11-19', windowEnd: '2026-11-25' })
    assert.deepEqual(
      [result.filled_events, result.deferred_events, result.blocked_events, result.skipped_events, result.total_events],
      [2, 4, 3, 3, 12],
    )
    assert.equal(result.total_events, result.filled_events + result.deferred_events + result.blocked_events + result.skipped_events)
    assert.equal(result.cancelled_events, 1)
    assert.deepEqual([result.window_start, result.window_end], ['2026-11-19', '2026-11-25'])
    assert.ok(result.rows.every((row) => row.event_type === 'pending_buy'))
    assert.ok(!result.rows.some((row) => row.status === 'defer' || row.status === 'submitted'))
    const blocked = result.rows.filter((row) => row.outcome === 'blocked').map((row) => `${row.status}:${row.reason}`).sort()
    assert.deepEqual(blocked, ['checked_waiting:swing_market_below_ma60', 'checked_waiting:swing_recovery_expired', 'quote_unavailable:shioaji_quote_missing'])
    assert.ok(!result.rows.some((row) => row.status === 'execution_blocked'), 'companions are never counted on their own')
    assert.ok(result.rows.some((row) => row.outcome === 'deferred' && row.reason === 'swing_breakout_confirmed'), 'a submitted note companion is not paired with the earlier checked_waiting')
  } finally {
    sql.close()
  }
})

test('Taiwan trading-date window maps to UTC bounds', () => {
  assert.deepEqual(gateWindowUtcBounds('2026-11-19', '2026-11-25'), {
    coarseStart: '2026-11-18', coarseEnd: '2026-11-26', startUtc: '2026-11-18 16:00:00', endUtc: '2026-11-25 16:00:00',
  })
})

test('gate checks seek the trading-date index and rowid ranges; filled seeks (account_id, side, created_at)', () => {
  const sql = openPaper()
  try {
    const plan = (query: string, ...params: Array<string | number>) =>
      sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params).map((row) => String(row.detail))
    const checks = plan(PAPER_GATE_CHECKS_SQL, '2026-11-19', '2026-11-25', 1)
    assert.ok(checks.some((d) => /^SEARCH p USING INDEX idx_paper_execution_events_date \(trade_date>\? AND trade_date<\?\)/.test(d)), checks.join(' | '))
    assert.ok(checks.some((d) => /SEARCH b USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/.test(d)), checks.join(' | '))
    assert.ok(checks.some((d) => /SEARCH m USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/.test(d)), checks.join(' | '))
    assert.ok(!checks.some((d) => /^SCAN (p|b|m|paper_execution_events)\b|idx_paper_execution_events_account_created/.test(d)), checks.join(' | '))
    const filled = plan(PAPER_GATE_FILLED_SQL, 1, '2026-11-18', '2026-11-26', '2026-11-18 16:00:00', '2026-11-25 16:00:00')
    assert.ok(filled.some((d) => /^SEARCH paper_orders USING INDEX idx_paper_orders_account_side_created \(account_id=\? AND side=\? AND created_at>\? AND created_at<\?\)/.test(d)), filled.join(' | '))
  } finally {
    sql.close()
  }
})
