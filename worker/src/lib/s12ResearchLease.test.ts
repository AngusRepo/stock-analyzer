import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import {
  acquireS12ResearchLeaseDetailed,
  assertS12ResearchLeaseRenewed,
  releaseS12ResearchLease,
  renewS12ResearchLease,
} from './s12ResearchLease'

test('serializes replay/calibration owners with 1800s expiry takeover and exact release', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['OPS'],
  })
  try {
    const db = await mf.getD1Database('OPS')
    await db.prepare(`
      CREATE TABLE scheduler_locks (
        lock_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        run_date TEXT,
        run_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT
      )
    `).run()
    const nowMs = Date.parse('2026-08-23T21:00:00.000Z')
    const ownerA = await acquireS12ResearchLeaseDetailed(
      db,
      'calibration-a',
      '2026-08-23',
      1800,
      nowMs,
    )
    assert.equal(ownerA.acquired, true)
    if (ownerA.acquired) {
      assert.equal(ownerA.leaseExpiresAt, '2026-08-23T21:30:00.000Z')
    }

    const busyB = await acquireS12ResearchLeaseDetailed(
      db,
      'replay-b',
      '2026-08-23',
      1800,
      nowMs + 60_000,
    )
    assert.equal(busyB.acquired, false)
    if (busyB.acquired === false) {
      assert.equal(busyB.holderRunId, 'calibration-a')
      assert.equal(busyB.leaseExpiresAt, '2026-08-23T21:30:00.000Z')
    }
    assert.equal(await releaseS12ResearchLease(db, 'replay-b'), false)
    assert.equal(await renewS12ResearchLease(db, 'calibration-a', 1800, nowMs + 600_000), true)

    const stillBusyB = await acquireS12ResearchLeaseDetailed(
      db,
      'replay-b',
      '2026-08-23',
      1800,
      nowMs + 1_801_000,
    )
    assert.equal(stillBusyB.acquired, false)

    const takeoverB = await acquireS12ResearchLeaseDetailed(
      db,
      'replay-b',
      '2026-08-23',
      1800,
      nowMs + 2_401_000,
    )
    assert.equal(takeoverB.acquired, true)
    assert.equal(await renewS12ResearchLease(db, 'calibration-a', 1800, nowMs + 2_402_000), false)
    await assert.rejects(
      assertS12ResearchLeaseRenewed(db, 'calibration-a'),
      /s12_research_lease_lost:calibration-a/,
    )
    assert.equal(await releaseS12ResearchLease(db, 'calibration-a'), false)
    assert.equal(await releaseS12ResearchLease(db, 'replay-b'), true)
    const throwingDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('injected_d1_renew_failure')
          },
        }),
      }),
    } as unknown as D1Database
    await assert.rejects(
      assertS12ResearchLeaseRenewed(throwingDb, 'last-row-writer'),
      /s12_research_lease_lost:last-row-writer/,
    )
    assert.equal(Number((await db.prepare(
      "SELECT COUNT(*) AS count FROM scheduler_locks WHERE lock_key='s12:research-market-data'",
    ).first<{ count?: number }>())?.count ?? -1), 0)
  } finally {
    await mf.dispose()
  }
})
