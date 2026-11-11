import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildStrategyFormalMatureCompatibilitySql } from './selectionReferenceEvidence'
import { buildStrategyEvidenceProfile } from './strategyEvidenceProfile'
import {
  attachFundamentalRevisionPersistence,
  attachMaximumAdverseExcursions,
  computeStrategyEvidenceMetricRows,
  loadObservations,
  loadObservationsAcrossDatabases,
  newStrategyEvidenceMarketCache,
  strategyEvidenceRegimeProjectionSql,
  STRATEGY_EVIDENCE_EMPTY_REGIME_PROJECTION,
  type StrategyEvidenceObservation,
} from './strategyEvidenceMetrics'
import { loadDateReturns } from './strategyEvidenceOwnerCalibration'
import { ensureStrategyLearningTables } from './strategyLearning'
import { metricPayloadChecksum } from './strategyMetricSnapshots'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'

// The base-table readers must return exactly what the former
// strategy_evidence_observations_v1 readers returned; the former SQL text is
// the reference. The plans must not scan the big tables or resolve
// alpha_context per row.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const COMPAT = buildStrategyFormalMatureCompatibilitySql('mr')
const [V4_REF, V4_LAB, PIT_LAB, V3_REF, V3_LAB] = COMPAT.binds
const day = (n: number) => new Date(Date.UTC(2026, 6, 1 + n)).toISOString().slice(0, 10)
const AS_OF = day(40)
const SYMBOLS = 120

type Recorded = { sql: string; params: unknown[] }

function d1(db: DatabaseSync, log?: Recorded[]): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { params = values; return statement },
        async all() {
          log?.push({ sql, params })
          return { success: true, results: db.prepare(sql).all(...(params as never[])), meta: {} }
        },
      }
      return statement
    },
  } as unknown as D1Database
}

function seed(): { db: DatabaseSync; heads: Record<string, string> } {
  const db = new DatabaseSync(':memory:')
  db.exec(read('../../domain-schemas/learning.sql'))
  db.exec(read('../../domain-migrations/learning/0011_strategy_multi_horizon_outcomes.sql'))
  db.exec(read('../../domain-migrations/learning/0015_strategy_evidence_profile_index.sql'))
  db.exec(read('../../domain-migrations/learning/0020_evidence_session_owner_read_models.sql'))
  const ref = db.prepare(`INSERT INTO selection_reference_snapshots_v1(signal_date,symbol,producer_run_id,hard_gate_passed,hard_gate_reason,
    feature_available,strategy_labeled,strategy_selected,selection_stage,strategy_matrix_status,strategy_registry_checksum,
    feature_contract_version,strategy_labeler_version) VALUES (?,?,?,1,'ok',1,1,0,'scored',?,?,?,?)`)
  const run = db.prepare(`INSERT INTO strategy_label_matrix_runs_v4(producer_run_id,signal_date,status,reference_candidate_count,strategy_count,
    expected_cell_count,persisted_cell_count,strategy_registry_checksum,labeler_version,reference_contract_version) VALUES (?,?,?,1,2,?,?,?,?,?)`)
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,strategy_status,
    alpha_bucket,family_id,production_owner,strategy_hit,evaluable,weak_label,affinity,affinity_version,affinity_evidence_count,position_weight,
    challenger_affinity,challenger_affinity_version,overlap,labeler_version,strategy_registry_checksum,reference_contract_version)
    VALUES (?,?,?,?,'v1','active','trend','fam',1,?,?,0.1,?,'binary',?,?,?,?,?,?,'chk',?)`)
  const outcome = db.prepare(`INSERT INTO canonical_selection_outcomes_v1(signal_date,symbol,producer_run_id,horizon_days,label_schema_version,
    entry_date,exit_date,outcome_known_date,gross_return,transaction_cost_bps,absolute_return_net,benchmark_return_net,benchmark_scope,
    residual_return_net,cross_section_rank,adjustment_source,reference_contract_version)
    VALUES (?,?,?,?,?,date(?,'+1 day'),?,?,0.1,18,?,?,'sector',?,?,'adj',?)`)
  const snapshot = db.prepare(`INSERT INTO allocator_ev_feature_snapshots(snapshot_date,stock_id,symbol,alpha_allocation,alpha_context,
    as_of_guard,snapshot_source,generated_at) VALUES (?,?,?,'{}',?,'guard',?,?)`)
  const contexts = [
    { regime: 'bull', market_regime_context: { point_in_time: true, large: 'x'.repeat(64) } },
    { regime: 'unknown', regime_surface: { bull: 0.1, volatile: 0.7 } },
    { market_regime_context: { point_in_time: false, regime_bucket: 'bull', regime_surface: { bear: 1 } } },
    { market_regime_context: { regime_surface: { bull: 0.2, bear: 0.6 } } },
    { market_regime_context: { point_in_time: true, regime_bucket: 'sideways' }, regime: 'bear' },
  ]
  const heads: Record<string, string> = {}
  for (let n = 0; n < 42; n++) {
    const date = day(n)
    if (n !== 7) heads[date] = `run-${n}`
    // A v3 date, a pit-reconstruction date, an incompatible pair, an
    // incomplete matrix and a writing run all go through the same filters.
    const [contract, labeler] = n % 5 === 1 ? [V3_REF, V3_LAB] : n % 5 === 2 ? [V4_REF, PIT_LAB] : n === 9 ? [V3_REF, V4_LAB] : [V4_REF, V4_LAB]
    for (const producer of [`run-${n}`, `stale-${n}`]) {
      run.run(producer, date, n === 11 ? 'writing' : 'ready', 80, n === 13 ? 79 : 80, n === 15 ? 'other' : 'chk', labeler, contract)
      for (let k = 0; k < SYMBOLS; k++) {
        const symbol = String(1000 + k)
        if (!(n === 17 && k < 10)) ref.run(date, symbol, producer, n === 19 && k % 2 ? 'unavailable' : 'ready', 'chk', contract, labeler)
        for (const strategy of ['alpha', 'beta']) {
          const hit = (k * 7 + n + (strategy === 'beta' ? 1 : 0)) % 3 === 0 ? 0 : 1
          const challengerVersion = k % 4 === 0 ? 'strategy-threshold-margin-affinity-v1' : 'strategy-threshold-margin-affinity-v2'
          cell.run(date, symbol, producer, strategy, hit, k % 11 === 5 ? 0 : 1, (k % 3) / 2, k % 6 === 1 ? 0 : 2,
            1 + (k % 3), 0.1 + k / 100, challengerVersion, k / SYMBOLS, labeler, contract)
        }
        if (k % 9 === 8) continue
        for (const h of [3, 5, 10]) {
          const known = new Date(Date.parse(date) + (h + 1) * 86_400_000).toISOString().slice(0, 10)
          const residual = ((k * 13 + n * 7 + h) % 19 - 9) / 1000 + 1 / (3 + k + n)
          outcome.run(date, symbol, producer, h, 'canonical-strategy-selection-outcome-v1', date, known, known,
            residual + 0.003, 0.003, residual, (k % 10) / 10, contract)
        }
        if (k % 4 !== 3 && producer === `run-${n}`) {
          const context = k % 13 === 12 ? null : JSON.stringify(contexts[(k + n) % contexts.length])
          snapshot.run(date, 1 + k, symbol, context, 'a', '2026-10-01 10:00:00')
          // Same generated_at from another source: the lowest rowid wins.
          if (k % 5 === 0) snapshot.run(date, 1 + k, symbol, JSON.stringify(contexts[(k + n + 1) % contexts.length]), 'b', '2026-10-01 10:00:00')
          if (k % 6 === 0) snapshot.run(date, 1 + k, symbol, JSON.stringify(contexts[(k + n + 2) % contexts.length]), 'c', '2026-10-02 09:00:00')
        }
      }
    }
  }
  return { db, heads }
}

// The VIEW-based readers as they were before the base-table rewrite.
async function legacyObservations(
  db: DatabaseSync, asOf: string, heads: Record<string, string>, profile?: { strategy_id: string; strategy_version: string },
): Promise<StrategyEvidenceObservation[]> {
  const output: StrategyEvidenceObservation[] = []
  let matrixRowId = 0
  let horizonDays = 0
  for (;;) {
    const rows = db.prepare(`
      SELECT v.matrix_row_id, v.signal_date, v.symbol, v.producer_run_id,
             v.strategy_id, v.strategy_version, v.strategy_status, v.alpha_bucket,
             v.legacy_binary_affinity AS affinity, v.legacy_affinity_version AS affinity_version,
             v.affinity_evidence_count, v.evidence_affinity AS challenger_affinity,
             v.evidence_affinity_version AS challenger_affinity_version, v.position_weight, v.overlap,
             v.horizon_days, v.outcome_known_date, v.entry_date, v.exit_date,
             v.absolute_return_net, v.benchmark_return_net, v.residual_return_net, v.cross_section_rank,
             ${strategyEvidenceRegimeProjectionSql('v.alpha_context')} AS alpha_context
        FROM strategy_evidence_observations_v1 v
       WHERE v.outcome_known_date<=? ${profile ? 'AND v.strategy_id=? AND v.strategy_version=?' : ''}
         AND EXISTS (SELECT 1 FROM selection_reference_snapshots_v1 r
            WHERE r.signal_date=v.signal_date AND r.symbol=v.symbol AND r.producer_run_id=v.producer_run_id
              AND r.strategy_matrix_status='ready'
              AND EXISTS (SELECT 1 FROM strategy_label_matrix_runs_v4 mr
                 WHERE mr.producer_run_id=v.producer_run_id AND ${COMPAT.sql} AND mr.status='ready'
                   AND mr.expected_cell_count>0 AND mr.persisted_cell_count=mr.expected_cell_count
                   AND mr.labeler_version=r.strategy_labeler_version
                   AND mr.strategy_registry_checksum=r.strategy_registry_checksum
                   AND mr.reference_contract_version=r.feature_contract_version))
         AND EXISTS (SELECT 1 FROM json_each(?) h WHERE h.key=v.signal_date AND h.value=v.producer_run_id)
         AND (v.matrix_row_id>? OR (v.matrix_row_id=? AND v.horizon_days>?))
       ORDER BY v.matrix_row_id, v.horizon_days
       LIMIT 5000
    `).all(asOf, ...(profile ? [profile.strategy_id, profile.strategy_version] : []), ...COMPAT.binds,
      JSON.stringify(heads), matrixRowId, matrixRowId, horizonDays) as unknown as Array<StrategyEvidenceObservation & { matrix_row_id: number }>
    output.push(...rows.map((row) => ({ ...row })))
    if (rows.length < 5000) break
    matrixRowId = Number(rows.at(-1)!.matrix_row_id)
    horizonDays = Number(rows.at(-1)!.horizon_days)
  }
  return output
}

function legacyDateReturns(db: DatabaseSync, strategyId: string, horizon: number, cutoff: string, heads: Record<string, string>) {
  return db.prepare(`
    SELECT v.signal_date, AVG(v.residual_return_net) residual_return_net, COUNT(*) sample_count
      FROM strategy_evidence_observations_v1 v
     WHERE v.strategy_id=? AND v.strategy_version=? AND v.horizon_days=? AND v.outcome_known_date < ?
       AND EXISTS (SELECT 1 FROM selection_reference_snapshots_v1 r
          WHERE r.signal_date=v.signal_date AND r.symbol=v.symbol AND r.producer_run_id=v.producer_run_id
            AND r.strategy_matrix_status='ready'
            AND EXISTS (SELECT 1 FROM strategy_label_matrix_runs_v4 mr
               WHERE mr.producer_run_id=v.producer_run_id AND mr.status='ready' AND ${COMPAT.sql}
                 AND mr.expected_cell_count>0 AND mr.persisted_cell_count=mr.expected_cell_count
                 AND mr.labeler_version=r.strategy_labeler_version
                 AND mr.strategy_registry_checksum=r.strategy_registry_checksum
                 AND mr.reference_contract_version=r.feature_contract_version))
       AND EXISTS (SELECT 1 FROM json_each(?) h WHERE h.key=v.signal_date AND h.value=v.producer_run_id)
     GROUP BY v.signal_date ORDER BY v.signal_date
  `).all(strategyId, 'v1', horizon, cutoff, ...COMPAT.binds, JSON.stringify(heads)).map((row) => ({
    signal_date: row.signal_date,
    strategy_id: strategyId,
    strategy_version: 'v1',
    residual_return_net: Number(row.residual_return_net),
    sample_count: Number(row.sample_count),
  }))
}

const withoutRegime = (rows: StrategyEvidenceObservation[]) => rows.map(({ market_regime: _regime, ...row }) => row)

test('the empty regime projection is what SQLite projects for a NULL alpha_context', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const row = db.prepare(`SELECT ${strategyEvidenceRegimeProjectionSql('NULL')} AS alpha_context`).get() as { alpha_context: string }
    assert.equal(row.alpha_context, STRATEGY_EVIDENCE_EMPTY_REGIME_PROJECTION)
  } finally { db.close() }
})

test('base-table observations equal the VIEW observations row for row, across pages', async () => {
  const { db, heads } = seed()
  try {
    const spec = DEFAULT_STRATEGY_SPECS.find((item) => item.id === 'trend_following_seed_v1')!
    for (const profile of [{ strategy_id: 'alpha', strategy_version: 'v1' }, { strategy_id: 'beta', strategy_version: 'v1' }, undefined]) {
      for (const asOf of [AS_OF, day(20)]) {
        const expected = await legacyObservations(db, asOf, heads, profile)
        const actual = await loadObservations(d1(db), asOf, heads, profile)
        assert.deepEqual(withoutRegime(actual), expected)
        if (asOf === AS_OF) assert.ok(expected.length > 5000, `fixture must span more than one page: ${expected.length}`)
        // The regime the metrics read is resolved from the same projection.
        const regimes = new Set(actual.map((row) => row.market_regime))
        for (const regime of ['bull', 'bear', 'sideways', 'volatile', null]) assert.ok(regimes.has(regime), `regime ${regime}`)
        // Same metric rows and the same snapshot payload checksum.
        const evidenceProfile = buildStrategyEvidenceProfile({ ...spec, id: profile?.strategy_id ?? 'alpha', version: 'v1' },
          { availableOutcomeHorizonDays: [3, 5, 10] })
        const metric = (rows: StrategyEvidenceObservation[]) => computeStrategyEvidenceMetricRows(evidenceProfile,
          rows.filter((row) => row.strategy_id === evidenceProfile.strategy_id), asOf)
        assert.equal(await metricPayloadChecksum(metric(actual)), await metricPayloadChecksum(metric(expected)))
      }
    }
    // One projection read serves every profile of a task.
    const log: Recorded[] = []
    const shared = await loadObservations(d1(db), AS_OF, heads, { strategy_id: 'alpha', strategy_version: 'v1' })
    const projections = new Map(shared.map((row) => [`${row.signal_date}|${row.symbol}`, row.alpha_context!]))
    await loadObservations(d1(db, log), AS_OF, heads, { strategy_id: 'alpha', strategy_version: 'v1' }, projections)
    assert.ok(log.every((entry) => !entry.sql.includes('allocator_ev_feature_snapshots')))
  } finally { db.close() }
})

test('cross-D1 observations resolve the same latest snapshot projection as the former subquery', async () => {
  const { db, heads } = seed()
  try {
    const expected = db.prepare(`
      SELECT o.signal_date, o.symbol, (SELECT ${strategyEvidenceRegimeProjectionSql('a.alpha_context')} FROM allocator_ev_feature_snapshots a
        WHERE a.snapshot_date=o.signal_date AND a.symbol=o.symbol ORDER BY a.generated_at DESC LIMIT 1) alpha_context
        FROM canonical_selection_outcomes_v1 o
    `).all() as Array<{ signal_date: string; symbol: string; alpha_context: string | null }>
    const bySelection = new Map(expected.map((row) => [`${row.signal_date}|${row.symbol}`, row.alpha_context]))
    assert.ok([...bySelection.values()].includes(null))
    const actual = await loadObservationsAcrossDatabases(d1(db), d1(db), AS_OF, heads)
    assert.ok(actual.length > 5000)
    for (const row of actual) assert.equal(row.alpha_context, bySelection.get(`${row.signal_date}|${row.symbol}`))
    // Matrix-side columns are unchanged; only the outcome-side projection moved.
    const viewRows = await legacyObservations(db, AS_OF, heads)
    const strip = (rows: StrategyEvidenceObservation[]) => rows.map((row) => [row.signal_date, row.symbol, row.producer_run_id,
      row.strategy_id, row.horizon_days, row.residual_return_net].join('|')).sort()
    assert.deepEqual(strip(actual), strip(viewRows))
  } finally { db.close() }
})

test('base-table date returns equal the VIEW date returns', async () => {
  const { db, heads } = seed()
  try {
    const profiles = [
      { strategy_id: 'alpha', strategy_version: 'v1', strategy_status: 'active', primary_horizon_days: 5 },
      { strategy_id: 'beta', strategy_version: 'v1', strategy_status: 'active', primary_horizon_days: 10 },
      { strategy_id: 'beta', strategy_version: 'v1', strategy_status: 'shadow', primary_horizon_days: 3 },
    ]
    for (const cutoff of [AS_OF, day(25)]) {
      const actual = await loadDateReturns(d1(db), profiles as never, cutoff, heads)
      const expected = [...legacyDateReturns(db, 'alpha', 5, cutoff, heads), ...legacyDateReturns(db, 'beta', 10, cutoff, heads)]
      assert.ok(expected.length > 20)
      assert.deepEqual(actual, expected)
    }
  } finally { db.close() }
})

test('the rewritten readers never scan the big tables or resolve alpha_context per row', async () => {
  const { db, heads } = seed()
  try {
    const log: Recorded[] = []
    await loadObservations(d1(db, log), AS_OF, heads, { strategy_id: 'alpha', strategy_version: 'v1' })
    await loadObservationsAcrossDatabases(d1(db, log), d1(db, log), AS_OF, heads)
    await loadDateReturns(d1(db, log), [{ strategy_id: 'alpha', strategy_version: 'v1', strategy_status: 'active', primary_horizon_days: 5 }] as never, AS_OF, heads)
    const plans = [...new Map(log.map((entry) => [entry.sql, entry])).values()]
      .filter((entry) => /strategy_label_matrix_v4|allocator_ev_feature_snapshots|canonical_selection_outcomes_v1/.test(entry.sql))
    assert.ok(plans.length >= 4)
    for (const { sql, params } of plans) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>)
        .map((row) => row.detail)
      const text = plan.join('\n')
      // Only the allocator projection may read allocator_ev_feature_snapshots,
      // and never as a correlated subquery.
      if (sql.includes('FROM strategy_label_matrix_v4 m') || sql.includes('FROM canonical_selection_outcomes_v1')) {
        assert.doesNotMatch(sql, /allocator_ev_feature_snapshots/)
      } else {
        assert.doesNotMatch(text, /CORRELATED/, text)
      }
      for (const detail of plan) {
        assert.doesNotMatch(detail, /^SCAN (m|o|a|strategy_label_matrix_v4|canonical_selection_outcomes_v1|allocator_ev_feature_snapshots)\b/, text)
      }
      if (sql.includes('idx_strategy_label_matrix_v4_profile_evidence')) {
        assert.match(text, /SEARCH m USING INDEX idx_strategy_label_matrix_v4_profile_evidence \(strategy_id=\? AND strategy_version=\? AND strategy_hit=\? AND evaluable=\?/, text)
        assert.match(text, /SEARCH o USING INDEX idx_canonical_selection_outcomes_v1_strategy_join \(signal_date=\? AND symbol=\? AND producer_run_id=\?/, text)
        assert.ok(plan.findIndex((detail) => detail.startsWith('SEARCH m')) < plan.findIndex((detail) => detail.startsWith('SEARCH o')), text)
      }
      if (sql.includes('allocator_ev_feature_snapshots')) {
        assert.match(text, /SEARCH allocator_ev_feature_snapshots USING INDEX idx_allocator_ev_snapshots_date \(snapshot_date>\? AND snapshot_date<\?\)/, text)
      }
    }
  } finally { db.close() }
})

test('market rows are read once per symbol across the profiles of one task', async () => {
  const market = new DatabaseSync(':memory:')
  try {
    market.exec(`CREATE TABLE canonical_market_daily(stock_id TEXT, date TEXT, source TEXT, adj_open REAL, adj_low REAL, PRIMARY KEY(stock_id,date,source));
      CREATE TABLE canonical_revenue_observations_v2(stock_id TEXT, revenue_month TEXT, yoy REAL, previous_comparison_pct REAL,
        knowledge_time TEXT, payload_checksum TEXT, source TEXT, PRIMARY KEY(stock_id,revenue_month,source,payload_checksum));`)
    const price = market.prepare("INSERT INTO canonical_market_daily VALUES (?,?,'finlab.price',?,?)")
    const revision = market.prepare("INSERT INTO canonical_revenue_observations_v2 VALUES (?,?,?,?,?,?,'finlab')")
    for (const symbol of ['1101', '2330', '2454']) {
      for (let n = 0; n < 60; n++) price.run(symbol, day(n), 100 + n + Number(symbol) % 7, 95 + (n * 7) % 11)
      for (let month = 1; month <= 6; month++) {
        revision.run(symbol, `2026-0${month}`, month * 2, null, `2026-0${month + 1}-10T00:00:00.000Z`, `a${month}`)
        revision.run(symbol, `2026-0${month}`, month * 2 + (Number(symbol) % 3) - 1, null, `2026-0${month + 1}-20T00:00:00.000Z`, `b${month}`)
      }
    }
    const observation = (strategy: string, symbol: string, signal: number, exit: number): StrategyEvidenceObservation => ({
      signal_date: day(signal), symbol, producer_run_id: 'run', strategy_id: strategy, strategy_version: 'v1',
      strategy_status: 'active', alpha_bucket: 'trend', affinity: 1, position_weight: 1, overlap: 0, horizon_days: 5,
      outcome_known_date: day(exit), absolute_return_net: 0, benchmark_return_net: 0, residual_return_net: 0, cross_section_rank: 0,
      entry_date: day(signal + 1), exit_date: day(exit),
    })
    // Profiles with overlapping symbols and windows reaching both sides of the cached one.
    const profiles = [
      [observation('a', '2330', 20, 30), observation('a', '1101', 22, 28)],
      [observation('b', '2330', 10, 18), observation('b', '2454', 15, 25), observation('b', '1101', 25, 45)],
      [observation('c', '2330', 12, 40), observation('c', '2454', 16, 24)],
    ]
    const separate = profiles.map((rows) => rows.map((row) => ({ ...row })))
    const log: Recorded[] = []
    const cache = newStrategyEvidenceMarketCache()
    for (const [index, rows] of profiles.entries()) {
      const keys = new Set([`${rows[0].strategy_id}|v1`])
      await attachMaximumAdverseExcursions(rows, d1(market, log), keys, cache)
      await attachFundamentalRevisionPersistence(rows, d1(market, log), keys, day(50), cache)
      await attachMaximumAdverseExcursions(separate[index], d1(market), keys)
      await attachFundamentalRevisionPersistence(separate[index], d1(market), keys, day(50))
    }
    assert.deepEqual(profiles, separate)
    assert.ok(profiles.flat().some((row) => row.maximum_adverse_excursion != null && row.maximum_adverse_excursion < 0))
    assert.ok(profiles.flat().some((row) => row.fundamental_revision_persistence != null))
    const priceRows = log.filter((entry) => entry.sql.includes('canonical_market_daily'))
      .flatMap((entry) => market.prepare(entry.sql).all(...(entry.params as never[])) as Array<{ symbol: string; date: string }>)
      .map((row) => `${row.symbol}|${row.date}`)
    assert.equal(new Set(priceRows).size, priceRows.length, 'a market price row was read twice')
    const revisionReads = log.filter((entry) => entry.sql.includes('canonical_revenue_observations_v2'))
      .flatMap((entry) => entry.params.slice(0, -1))
    assert.deepEqual([...revisionReads].sort(), ['1101', '2330', '2454'])
  } finally { market.close() }
})

test('strategy learning DDL runs once per binding and is retried after a failed pass', async () => {
  let statements = 0
  let failAt = 3
  const binding = {
    prepare() {
      return { async run() { statements += 1; if (statements === failAt) throw new Error('d1_overloaded') } }
    },
  } as unknown as D1Database
  await assert.rejects(Promise.all([ensureStrategyLearningTables(binding), ensureStrategyLearningTables(binding)]), /d1_overloaded/)
  assert.equal(statements, 3)
  failAt = -1
  await ensureStrategyLearningTables(binding)
  const onePass = statements - 3
  assert.ok(onePass > 20)
  await Promise.all([ensureStrategyLearningTables(binding), ensureStrategyLearningTables(binding)])
  assert.equal(statements, 3 + onePass)
  const other = { prepare: binding.prepare } as unknown as D1Database
  await ensureStrategyLearningTables(other)
  assert.equal(statements, 3 + 2 * onePass)
})

test('no learning migration drops an index the evidence readers force with INDEXED BY', async () => {
  const { readdirSync } = await import('node:fs')
  const dir = new URL('../../domain-migrations/learning/', import.meta.url)
  const forced = ['idx_strategy_label_matrix_v4_profile_evidence', 'idx_canonical_selection_outcomes_v1_strategy_join']
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
    const sql = readFileSync(new URL(file, dir), 'utf8')
    for (const index of forced) {
      assert.doesNotMatch(sql, new RegExp(`DROP\\s+INDEX\\s+(IF\\s+EXISTS\\s+)?${index}\\b`, 'i'),
        `${file} drops ${index}; INDEXED BY in strategyEvidenceMetrics/OwnerCalibration would fail with "no such index"`)
    }
  }
})
