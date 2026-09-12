import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Miniflare } from 'miniflare'
import { readPairedNav } from './pairedNavReadModel'

async function main() {
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("fixture") } }', d1Databases: ['NAV'] })
  try {
    const db = await mf.getD1Database('NAV')
    // Minimal legacy-compatible tables intentionally permit malformed rows.
    // This is a read-model corruption test, not a migration/ledger validator.
    await db.prepare('CREATE TABLE paired_nav_frozen_manifests_v1 (signal_date TEXT,snapshot_kind TEXT)').run()
    await db.prepare('CREATE TABLE paired_nav_daily_journal_v1 (pair_id TEXT,session_date TEXT,payload_json TEXT)').run()
    await db.prepare('CREATE TABLE paired_nav_lifecycle_closures_v1 (pair_id TEXT,transition_signal_date TEXT,payload_json TEXT,payload_checksum TEXT)').run()
    const body = (date: string) => ({ schema_version: 'paired-nav-journal-v1', pair_id: 'pair', session_date: date,
      net_return_delta: 0, pair_identity: { pair_id: 'pair', candidate_checksum: 'c', baseline_checksum: 'b',
        configuration_checksum: 'config', execution_owner_version: 'native' } })
    const insert = (date: string, payload: unknown) => db.prepare('INSERT INTO paired_nav_daily_journal_v1 VALUES (?,?,?)')
      .bind('pair', date, JSON.stringify(payload)).run()
    await insert('2026-09-07', body('2026-09-07'))
    const zero = await readPairedNav(db, '2026-09-08')
    assert.equal(zero.status, 'observing')
    assert.equal(zero.pairs[0].sessions, 1)
    const comparison = { schema_version: 'paired-nav-comparison-v1', owner: 'allocator_ev_fusion',
      kind: 'incremental_layer', baseline_kind: 'exact_frozen_l4_candidate', candidate_checksum: 'c', baseline_checksum: 'b' }
    await insert('2026-09-08', { ...body('2026-09-08'), comparison })
    const partiallyLabelled = (await readPairedNav(db, '2026-09-08')).pairs[0]
    assert.equal(partiallyLabelled.comparison?.metadata_sessions, 1,
      'partial legacy metadata must not claim all historical rows were annotated')
    assert.equal(partiallyLabelled.accounted_sessions, 2)
    await db.prepare("UPDATE paired_nav_daily_journal_v1 SET payload_json=? WHERE session_date='2026-09-07'")
      .bind(JSON.stringify({ ...body('2026-09-07'), comparison })).run()
    assert.equal((await readPairedNav(db, '2026-09-08')).pairs[0].comparison?.baseline_kind, 'exact_frozen_l4_candidate')
    for (const change of [{ kind: 'incumbent_replacement' }, { baseline_checksum: 'wrong' }, { owner: 'unknown' }]) {
      await db.prepare("UPDATE paired_nav_daily_journal_v1 SET payload_json=? WHERE session_date='2026-09-08'")
        .bind(JSON.stringify({ ...body('2026-09-08'), comparison: { ...comparison, ...change } })).run()
      assert.equal((await readPairedNav(db, '2026-09-08')).status, 'unavailable')
    }
    await db.prepare("UPDATE paired_nav_daily_journal_v1 SET payload_json=? WHERE session_date='2026-09-07'")
      .bind(JSON.stringify(body('2026-09-07'))).run()
    const route = { ...comparison, owner: 'l15_route', kind: 'route_policy_contrast', baseline_kind: 'frozen_incumbent_route' }
    for (const change of [{}, { kind: 'incumbent_replacement' }, { baseline_kind: 'frozen_incumbent_policy' }, { owner: 'ensemble' }]) {
      await db.prepare("UPDATE paired_nav_daily_journal_v1 SET payload_json=? WHERE session_date='2026-09-08'")
        .bind(JSON.stringify({ ...body('2026-09-08'), comparison: { ...route, ...change } })).run()
      const result = await readPairedNav(db, '2026-09-08')
      assert.equal(result.status, Object.keys(change).length ? 'unavailable' : 'observing')
      if (!Object.keys(change).length) assert.equal(result.pairs[0].comparison?.kind, 'route_policy_contrast')
    }
    for (const [owner, kind, baseline_kind] of [
      ['opb_arm_prior', 'allocator_policy_contrast', 'exact_frozen_incumbent_allocator'],
      ['atomic_strategy', 'atomic_strategy_replacement', 'frozen_incumbent_strategy_policy'],
    ]) {
      const original = { ...comparison, owner, kind, baseline_kind }
      for (const change of [{}, { kind: 'incumbent_replacement' }, { baseline_kind: 'frozen_incumbent_policy' },
        { owner: 'unknown' }, { candidate_checksum: 'wrong' }, { baseline_checksum: 'wrong' }]) {
        await db.prepare("UPDATE paired_nav_daily_journal_v1 SET payload_json=? WHERE session_date='2026-09-08'")
          .bind(JSON.stringify({ ...body('2026-09-08'), comparison: { ...original, ...change } })).run()
        const result = await readPairedNav(db, '2026-09-08')
        assert.equal(result.status, Object.keys(change).length ? 'unavailable' : 'observing', owner)
        if (!Object.keys(change).length) {
          assert.equal(result.pairs[0].comparison?.kind, kind)
          assert.equal(result.pairs[0].sessions, 2)
          assert.equal(result.promotion_allowed, false)
        }
      }
    }
    for (const delta of [null, '0.01', true, {}, []]) {
      await db.prepare("DELETE FROM paired_nav_daily_journal_v1 WHERE session_date='2026-09-08'").run()
      await insert('2026-09-08', { ...body('2026-09-08'), net_return_delta: delta })
      const result = await readPairedNav(db, '2026-09-08')
      assert.equal(result.status, delta === null ? 'valuation_incomplete' : 'unavailable')
      if (delta === null) {
        assert.equal(result.pairs[0].sessions, 1)
        assert.equal(result.pairs[0].accounted_sessions, 2)
      }
    }
    for (const key of ['candidate_checksum', 'baseline_checksum', 'configuration_checksum', 'execution_owner_version']) {
      for (const value of [null, '', 'different']) {
        await db.prepare("DELETE FROM paired_nav_daily_journal_v1 WHERE session_date='2026-09-08'").run()
        const payload = body('2026-09-08')
        await insert('2026-09-08', { ...payload, pair_identity: { ...payload.pair_identity, [key]: value } })
        assert.equal((await readPairedNav(db, '2026-09-08')).status, 'unavailable', `${key}:${value}`)
      }
    }
    await db.prepare("DELETE FROM paired_nav_daily_journal_v1 WHERE session_date='2026-09-08'").run()
    const overflowing = JSON.stringify(body('2026-09-08')).replace('"net_return_delta":0', '"net_return_delta":1e999')
    await db.prepare('INSERT INTO paired_nav_daily_journal_v1 VALUES (?,?,?)').bind('pair', '2026-09-08', overflowing).run()
    assert.equal((await readPairedNav(db, '2026-09-08')).status, 'unavailable', 'infinite JSON numeric value is not an observation')
    // An invalid later row must not leak into an earlier as-of request.
    assert.equal((await readPairedNav(db, '2026-09-07')).pairs[0].sessions, 1)
    await db.prepare("DELETE FROM paired_nav_daily_journal_v1 WHERE session_date='2026-09-08'").run()
    const zeroArm = { nav: 0, daily_return: null, return_status: 'undefined_zero_opening_nav' }
    const zeroBody = { ...body('2026-09-08'), net_return_delta: null,
      arms: { candidate: zeroArm, baseline: { nav: 100, daily_return: 0 } } }
    await insert('2026-09-08', zeroBody)
    const bankrupt = await readPairedNav(db, '2026-09-08')
    assert.equal(bankrupt.status, 'terminal_zero_nav')
    assert.equal(bankrupt.pairs[0].sessions, 1)
    assert.equal(bankrupt.pairs[0].accounted_sessions, 2)
    assert.equal(bankrupt.pairs[0].undefined_return_sessions, 1)
    assert.deepEqual(bankrupt.blockers, [])
    for (const baseline of [{ nav: null, daily_return: null }, { nav: 100, daily_return: null }]) {
      await db.prepare("DELETE FROM paired_nav_daily_journal_v1 WHERE session_date='2026-09-08'").run()
      await insert('2026-09-08', { ...zeroBody, arms: { candidate: zeroArm, baseline } })
      const mixed = await readPairedNav(db, '2026-09-08')
      assert.equal(mixed.status, 'valuation_incomplete', 'zero arm cannot hide other arm missing evidence')
      assert.equal(mixed.pairs[0].undefined_return_sessions, 0)
    }
    await db.prepare("DELETE FROM paired_nav_daily_journal_v1 WHERE session_date='2026-09-08'").run()
    await insert('2026-09-08', { ...body('2026-09-08'), net_return_delta: -1,
      arms: { candidate: { nav: 0, daily_return: -1 }, baseline: { nav: 100, daily_return: 0 } } })
    const loss = await readPairedNav(db, '2026-09-08')
    assert.equal(loss.status, 'terminal_zero_nav')
    assert.equal(loss.pairs[0].sessions, 2, 'actual -100% loss remains an observation')
    assert.equal(loss.pairs[0].undefined_return_sessions, 0)
    const transition = JSON.stringify({ schema_version: 'paired-nav-lifecycle-closure-v1', pair_id: 'pair',
      reason: 'comparison_changed', promotion_allowed: false, inherited_mature_sessions: 0,
      transition_signal_date: '2026-09-08', final_session_date: '2026-09-08',
      successor_pair_id: 'successor', changed_fields: ['configuration_checksum'] })
    await db.prepare('INSERT INTO paired_nav_lifecycle_closures_v1 VALUES (?,?,?,?)')
      .bind('pair', '2026-09-08', transition, createHash('sha256').update(transition).digest('hex')).run()
    const closed = await readPairedNav(db, '2026-09-08')
    assert.equal(closed.status, 'historical_comparisons')
    assert.equal(closed.pairs[0].sessions, 2, 'historical evidence remains visible')
    assert.equal(closed.pairs[0].lifecycle?.successor_pair_id, 'successor')
    assert.equal((await readPairedNav(db, '2026-09-07')).pairs[0].lifecycle, undefined)
    await db.prepare("UPDATE paired_nav_lifecycle_closures_v1 SET payload_checksum='wrong'").run()
    assert.equal((await readPairedNav(db, '2026-09-08')).status, 'unavailable')
    console.log('pairedNavReadModelSql: real D1 numeric, null, identity and cutoff checks passed')
  } finally {
    await mf.dispose()
  }
}
void main()
