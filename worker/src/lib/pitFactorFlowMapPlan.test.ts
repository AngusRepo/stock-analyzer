import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { PIT_FACTOR_FUNNEL_POINTS_SQL, PIT_FACTOR_TAXONOMY_MEMBERSHIP_SQL } from './pitFactorFlowMap'

// factor-flow-map was the ops-db 24h top reader on 2026-11-25: with bound parameters the funnel
// query walked idx_screener_funnel_items_date_id over all ~663K screener_funnel_items rows
// (8.3 s per call), and the membership query re-read each (snapshot_date, tag_type) slice once
// per 80-symbol chunk. Plans are checked with bound parameters, as D1 runs them.
const source = readFileSync('src/lib/pitFactorFlowMap.ts', 'utf8')
const STAGE = 'pit_residual_momentum_shadow'

function openDomain(domain: 'ops' | 'market'): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(`domain-schemas/${domain}.sql`, 'utf8'))
  return db
}

function plan(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => String(row.detail))
}

test('funnel points seek canonical runs, then (run_id, stage) per run, never scanning funnel items', () => {
  assert.match(source, /prepare\(PIT_FACTOR_FUNNEL_POINTS_SQL\)\s*\.bind\(requestedDate, RESIDUAL_STAGE, days, RESIDUAL_STAGE\)/)
  const db = openDomain('ops')
  try {
    const details = plan(db, PIT_FACTOR_FUNNEL_POINTS_SQL, '2026-11-25', STAGE, 20, STAGE)
    const text = details.join(' | ')
    assert.ok(details.includes('MATERIALIZE canonical_runs'), text)
    assert.ok(details.some((d) => /^SEARCH r USING INDEX idx_screener_funnel_runs_date/.test(d)), text)
    assert.ok(details.some((d) => /^SEARCH i USING INDEX idx_screener_funnel_items_run \(run_id=\? AND stage=\?\)/.test(d)), text)
    // The only SCAN allowed is the materialized CTE (<= days rows), aliased r in the outer query.
    assert.ok(!details.some((d) => /^SCAN (i|x|h)\b|^SCAN screener_funnel|idx_screener_funnel_items_date_id|BLOOM FILTER ON r/.test(d)), text)
    assert.deepEqual(details.filter((d) => /^SCAN /.test(d)), ['SCAN r'], text)

    db.exec(`
      INSERT INTO screener_funnel_runs(run_id, date, status, candidate_count) VALUES
        ('run-a', '2026-11-24', 'success', 11), ('run-b', '2026-11-25', 'success', 12),
        ('run-old', '2026-11-25', 'success', 99), ('run-c', '2026-11-26', 'success', 13);
      INSERT INTO canonical_run_heads(logical_run_key, run_id, promoted_at) VALUES
        ('screener:2026-11-24:TW:production:market_screener', 'run-a', 'x'),
        ('screener:2026-11-25:TW:production:market_screener', 'run-b', 'x'),
        ('screener:2026-11-26:TW:production:market_screener', 'run-c', 'x');
      INSERT INTO screener_funnel_items(run_id, date, symbol, stage, decision, reason_code) VALUES
        ('run-b', '2026-11-25', '2330', '${STAGE}', 'keep', 'r'),
        ('run-a', '2026-11-24', '2317', '${STAGE}', 'keep', 'r'),
        ('run-a', '2026-11-24', '2330', '${STAGE}', 'keep', 'r'),
        ('run-a', '2026-11-24', '9999', 'other_stage', 'keep', 'r'),
        ('run-old', '2026-11-25', '1111', '${STAGE}', 'keep', 'r'),
        ('run-c', '2026-11-26', '2454', '${STAGE}', 'keep', 'r');
    `)
    const rows = db.prepare(PIT_FACTOR_FUNNEL_POINTS_SQL).all('2026-11-25', STAGE, 2, STAGE)
      .map((row) => `${row.date}:${row.symbol}:${row.candidate_count}`)
    // Canonical heads only, the requested window only, ordered by (date, id).
    assert.deepEqual(rows, ['2026-11-24:2317:11', '2026-11-24:2330:11', '2026-11-25:2330:12'])
  } finally {
    db.close()
  }
})

test('taxonomy membership reads each (snapshot_date, tag_type) slice once with the symbol set as JSON', () => {
  assert.doesNotMatch(source, /index \+= 80|uniqueSymbols\.slice\(/)
  assert.match(source, /membership\.symbol IN \(SELECT value FROM json_each\(\?\)\)/)
  const db = openDomain('market')
  try {
    const sql = PIT_FACTOR_TAXONOMY_MEMBERSHIP_SQL(2)
    const details = plan(db, sql, '2026-11-24', '2026-11-25', 'industry', 'industry', '["2330","2317"]', null, null)
    const text = details.join(' | ')
    assert.ok(details.some((d) => /^SEARCH membership USING INDEX idx_sector_taxonomy_snapshot_v1_date_type \(snapshot_date=\? AND tag_type=\?\)/.test(d)), text)
    assert.ok(details.some((d) => /^SEARCH snapshot_runs USING /.test(d)), text)
    assert.ok(!details.some((d) => /^SCAN (membership|snapshot_runs|sector_taxonomy)/.test(d)), text)

    db.exec(`
      INSERT INTO sector_taxonomy_snapshot_runs_v1(snapshot_date, tag_type, snapshot_id, membership_checksum, expected_row_count, status) VALUES
        ('2026-11-20', 'industry', 'snap-20', 'c', 3, 'ready'),
        ('2026-11-25', 'industry', 'snap-25', 'c', 3, 'ready'),
        ('2026-11-26', 'industry', 'snap-26', 'c', 3, 'writing');
      INSERT INTO sector_taxonomy_membership_snapshots_v1(snapshot_date, snapshot_id, tag_type, tag, symbol, source, source_as_of_date, membership_checksum) VALUES
        ('2026-11-20', 'snap-20', 'industry', 'semi', '2330', 'finlab.security_industry_themes', '2026-11-20', 'c'),
        ('2026-11-20', 'snap-20', 'industry', 'ems', '2317', 'finlab.security_industry_themes', '2026-11-20', 'c'),
        ('2026-11-20', 'snap-20', 'industry', 'ic', '2454', 'finlab.security_industry_themes', '2026-11-20', 'c'),
        ('2026-11-25', 'snap-25', 'industry', 'foundry', '2330', 'finlab.security_industry_themes', '2026-11-25', 'c');
    `)
    const rows = db.prepare(sql).all('2026-11-24', '2026-11-25', 'industry', 'industry', '["2330","2317"]', null, null)
      .map((row) => `${row.date}:${row.symbol}:${row.tag}`)
    // Latest ready snapshot on or before each signal date; symbols outside the set are excluded.
    assert.deepEqual(rows, ['2026-11-24:2317:ems', '2026-11-24:2330:semi', '2026-11-25:2330:foundry'])
  } finally {
    db.close()
  }
})
