import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'
import {
  inspectS12TwCalibrationLifecycleCensoring,
  loadS12TwCalibrationEvidence,
} from './s12TwEquityCalibration'

test('includes terminal lifecycle evidence and censors partial, missing, and post-snapshot cohorts', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['LEARNING'],
  })
  try {
    const db = await mf.getD1Database('LEARNING')
    await db.prepare(`
      CREATE TABLE allocator_ev_daily_lifecycle (
        business_date TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run()
    await db.prepare(`
      CREATE TABLE s12_replay_trade_outcomes (
        id INTEGER PRIMARY KEY,
        symbol TEXT NOT NULL,
        signal_date TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        assessment_state TEXT,
        market TEXT,
        entry_ms INTEGER,
        entry_price REAL,
        stop_price REAL,
        pnl_pct REAL,
        max_favorable_pct REAL,
        max_adverse_pct REAL,
        sample_eligible INTEGER NOT NULL,
        detail_json TEXT NOT NULL
      )
    `).run()

    const nowMs = Date.parse('2026-08-24T02:00:00.000Z')
    const lifecycleRows = [
      ['2026-08-01', 'replay_complete', '2026-08-23T00:00:00.000Z'],
      ['2026-08-02', 'replay_pending_maturity', '2026-08-23T00:00:00.000Z'],
      ['2026-08-03', 'replay_enqueued', '2026-08-24T01:00:00.000Z'],
      ['2026-08-04', 'replay_enqueued', '2026-08-23T00:00:00.000Z'],
      ['2026-08-06', 'replay_complete', new Date(Date.now() + 60_000).toISOString()],
    ] as const
    for (const values of lifecycleRows) {
      await db.prepare(`
        INSERT INTO allocator_ev_daily_lifecycle (business_date, state, updated_at)
        VALUES (?, ?, ?)
      `).bind(...values).run()
    }

    const detailJson = JSON.stringify({
      replay_diagnostics: {
        replay_engine_signature: S12_REPLAY_ENGINE_SIGNATURE,
        replay_cohort_signature: 'terminal-fixture-v1',
      },
      assessment_detail: 'atr15m=2;equity_mutation_score=5;vwap_fast_reasons=reclaim|volume;vwap_fast_blockers=;session_60m_move_atr=0.8;session_60m_close_position=0.75',
      market_segment: 'LISTED',
      alpha_bucket: 'high',
    })
    const signalDates = [
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
    ]
    for (const [index, signalDate] of signalDates.entries()) {
      await db.prepare(`
        INSERT INTO s12_replay_trade_outcomes (
          id, symbol, signal_date, trade_date, assessment_state, market,
          entry_ms, entry_price, stop_price, pnl_pct, max_favorable_pct,
          max_adverse_pct, sample_eligible, detail_json
        ) VALUES (?, ?, ?, ?, 'reaction_ready', 'LISTED', ?, 100, 98, 0.01, 0.03, -0.01, 1, ?)
      `).bind(
        index + 1,
        `S${index + 1}`,
        signalDate,
        '2026-08-10',
        Date.parse('2026-08-10T01:30:00.000Z'),
        detailJson,
      ).run()
    }

    const censoring = await inspectS12TwCalibrationLifecycleCensoring(
      db,
      '2026-08-23',
      'weekly',
      nowMs,
    )
    assert.equal(censoring.completeRows, 2)
    assert.equal(censoring.pendingMaturityTerminalRows, 1)
    assert.equal(censoring.recentEnqueuedRows, 1)
    assert.deepEqual(censoring.recentEnqueuedDates, ['2026-08-03'])
    assert.equal(censoring.staleEnqueuedRows, 1)
    assert.deepEqual(censoring.staleEnqueuedDates, ['2026-08-04'])
    assert.equal(censoring.missingOrOtherRows, 1)
    assert.equal(censoring.missingOrOtherDates, 1)

    const evidence = await loadS12TwCalibrationEvidence(db, '2026-05-25', '2026-08-23')
    assert.deepEqual(evidence.map((row) => row.symbol), ['S1', 'S2'])
  } finally {
    await mf.dispose()
  }
})
