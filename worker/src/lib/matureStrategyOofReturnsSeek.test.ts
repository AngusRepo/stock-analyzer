import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { readdirSync } from 'node:fs'
import { buildMatureStrategyOofReturnsSql, loadMatureStrategyOofReturns } from './marketScreener'
import { buildStrategyFormalMatureCompatibilitySql, SELECTION_REFERENCE_FORMAL_MATURE_COMPATIBILITY } from './selectionReferenceEvidence'
import { CANONICAL_SELECTION_ADJUSTMENT_SOURCE } from './canonicalSelectionLabels'

// The previous query joined the matrix by signal_date alone and kept the hits
// afterwards: 4.6M rows and 32 s per screener run on 2026-11-06. The seek form
// must return exactly the same rows and aggregates.
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const TABLES = ['strategy_label_matrix_v4', 'canonical_selection_labels_v4', 'strategy_label_matrix_runs_v4']
const compat = buildStrategyFormalMatureCompatibilitySql('mr')

const legacySql = `
    WITH mature_dates AS (
      SELECT DISTINCT signal_date
        FROM canonical_selection_labels_v4
       WHERE outcome_known_date <= ?
         AND signal_date < ?
         AND label_schema_version = 'canonical-strategy-selection-label-v4'
       ORDER BY signal_date DESC
       LIMIT 60
    )
    SELECT m.strategy_id, m.signal_date,
           AVG(l.residual_return_net) residual_return,
           COUNT(*) sample_count
      FROM strategy_label_matrix_v4 m
      JOIN mature_dates d ON d.signal_date=m.signal_date
      JOIN canonical_selection_labels_v4 l
        ON l.signal_date=m.signal_date
       AND l.symbol=m.symbol
       AND l.producer_run_id=m.producer_run_id
       AND l.label_schema_version='canonical-strategy-selection-label-v4'
       AND l.adjustment_source=?
       AND l.reference_contract_version=m.reference_contract_version
     WHERE m.evaluable=1
       AND m.strategy_hit=1
       AND EXISTS (
         SELECT 1 FROM strategy_label_matrix_runs_v4 mr
          WHERE mr.producer_run_id=m.producer_run_id AND mr.status='ready'
            AND mr.reference_contract_version=m.reference_contract_version
            AND ${compat.sql}
            AND mr.labeler_version=m.labeler_version
       )
       AND EXISTS (
         SELECT 1 FROM json_each(?) h
          WHERE h.key=m.signal_date AND h.value=m.producer_run_id
       )
     GROUP BY m.strategy_id, m.signal_date
    HAVING COUNT(*) >= 3
     ORDER BY m.strategy_id, m.signal_date
`

// The 2026-11-07 seek form: hit cells only, but every hit re-scanned the canonical
// run-id JSON and mature_dates read every label row of the newest dates
// (3.7M rows per call on 2026-11-12). Kept verbatim as a second reference.
const formerSeekSql = `
    WITH RECURSIVE mature_dates AS (
      SELECT DISTINCT signal_date
        FROM canonical_selection_labels_v4
       WHERE +outcome_known_date <= ?
         AND signal_date < ?
         AND label_schema_version = 'canonical-strategy-selection-label-v4'
       ORDER BY signal_date DESC
       LIMIT 60
    ),
    strategies(signal_date, strategy_id) AS (
      SELECT d.signal_date,
             (SELECT MIN(m.strategy_id) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=d.signal_date)
        FROM mature_dates d
      UNION ALL
      SELECT s.signal_date,
             (SELECT MIN(m.strategy_id) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=s.signal_date AND m.strategy_id>s.strategy_id)
        FROM strategies s
       WHERE s.strategy_id IS NOT NULL
    )
    SELECT m.strategy_id, m.signal_date,
           AVG(l.residual_return_net) residual_return,
           COUNT(*) sample_count
      FROM strategies s
      CROSS JOIN strategy_label_matrix_v4 m
        ON m.signal_date=s.signal_date
       AND m.strategy_id=s.strategy_id
       AND m.evaluable=1
       AND m.strategy_hit=1
      CROSS JOIN canonical_selection_labels_v4 l
        ON l.signal_date=m.signal_date
       AND l.symbol=m.symbol
       AND l.producer_run_id=m.producer_run_id
       AND l.label_schema_version='canonical-strategy-selection-label-v4'
       AND l.adjustment_source=?
       AND l.reference_contract_version=m.reference_contract_version
     WHERE s.strategy_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM strategy_label_matrix_runs_v4 mr
          WHERE mr.producer_run_id=m.producer_run_id AND mr.status='ready'
            AND mr.reference_contract_version=m.reference_contract_version
            AND ${compat.sql}
            AND mr.labeler_version=m.labeler_version
       )
       AND EXISTS (
         SELECT 1 FROM json_each(?) h
          WHERE h.key=m.signal_date AND h.value=m.producer_run_id
       )
     GROUP BY m.strategy_id, m.signal_date
    HAVING COUNT(*) >= 3
     ORDER BY m.strategy_id, m.signal_date
`

// The 2026-11-12 form (production until learning 0069): canonical JSON expanded once and
// the bounded mature-date walk, but every hit cell still read its matrix table row and its
// run header (453,696 rows, 13.4 s on 2026-11-14). Kept verbatim as the third reference.
// Bind order: as-of date three times, the canonical run-id JSON, the adjustment source,
// then the compatibility pairs.
const walkSeekSql = `
    WITH RECURSIVE mature_dates(signal_date, n) AS (
      SELECT (SELECT MAX(signal_date)
                FROM canonical_selection_labels_v4
               WHERE +outcome_known_date <= ?
                 AND signal_date < ?
                 AND label_schema_version = 'canonical-strategy-selection-label-v4'), 1
      UNION ALL
      SELECT (SELECT MAX(l.signal_date)
                FROM canonical_selection_labels_v4 l
               WHERE +l.outcome_known_date <= ?
                 AND l.signal_date < d.signal_date
                 AND l.label_schema_version = 'canonical-strategy-selection-label-v4'), d.n + 1
        FROM mature_dates d
       WHERE d.signal_date IS NOT NULL AND d.n < 60
    ),
    canonical_dates(signal_date, producer_run_id) AS MATERIALIZED (
      SELECT DISTINCT d.signal_date, h.value
        FROM mature_dates d
        JOIN json_each(?) h ON h.key=d.signal_date
       WHERE d.signal_date IS NOT NULL
    ),
    strategies(signal_date, producer_run_id, strategy_id) AS (
      SELECT c.signal_date, c.producer_run_id,
             (SELECT MIN(m.strategy_id) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=c.signal_date)
        FROM canonical_dates c
      UNION ALL
      SELECT s.signal_date, s.producer_run_id,
             (SELECT MIN(m.strategy_id) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=s.signal_date AND m.strategy_id>s.strategy_id)
        FROM strategies s
       WHERE s.strategy_id IS NOT NULL
    )
    SELECT m.strategy_id, m.signal_date,
           AVG(l.residual_return_net) residual_return,
           COUNT(*) sample_count
      FROM strategies s
      CROSS JOIN strategy_label_matrix_v4 m
        ON m.signal_date=s.signal_date
       AND m.strategy_id=s.strategy_id
       AND m.evaluable=1
       AND m.strategy_hit=1
       AND m.producer_run_id=s.producer_run_id
      CROSS JOIN canonical_selection_labels_v4 l
        ON l.signal_date=m.signal_date
       AND l.symbol=m.symbol
       AND l.producer_run_id=m.producer_run_id
       AND l.label_schema_version='canonical-strategy-selection-label-v4'
       AND l.adjustment_source=?
       AND l.reference_contract_version=m.reference_contract_version
     WHERE s.strategy_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM strategy_label_matrix_runs_v4 mr
          WHERE mr.producer_run_id=m.producer_run_id AND mr.status='ready'
            AND mr.reference_contract_version=m.reference_contract_version
            AND ${compat.sql}
            AND mr.labeler_version=m.labeler_version
       )
     GROUP BY m.strategy_id, m.signal_date
    HAVING COUNT(*) >= 3
     ORDER BY m.strategy_id, m.signal_date
  `

function openDb(options: { withoutIndex?: string } = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const table of TABLES) {
    db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0])
    for (const index of schema.matchAll(new RegExp(`CREATE INDEX IF NOT EXISTS (\\w+)\\s+ON ${table}\\([^;]*;`, 'g'))) {
      if (index[1] !== options.withoutIndex) db.exec(index[0])
    }
  }
  return db
}

// Current bind order: as-of date three times, the canonical run-id JSON, the compatibility
// pairs, then the adjustment source.
const currentBinds = (json: string) => [AS_OF, AS_OF, AS_OF, json, ...compat.binds, CANONICAL_SELECTION_ADJUSTMENT_SOURCE]
const walkSeekBinds = (json: string) => [AS_OF, AS_OF, AS_OF, json, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, ...compat.binds]

// Deterministic generator so a failure reproduces.
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const AS_OF = '2026-11-06'
const CONTRACTS = SELECTION_REFERENCE_FORMAL_MATURE_COMPATIBILITY

// Mostly the run's contract; sometimes another formal contract (which a deviating cell
// may carry) or an unknown one.
function labelContract(draw: number, runContract: string): string {
  if (draw < 0.8) return runContract
  if (draw < 0.9) return CONTRACTS[draw < 0.85 ? 0 : 1].referenceContractVersion
  return 'other-contract'
}

function seed(db: DatabaseSync, seedValue: number): Record<string, string> {
  const random = rng(seedValue)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const dates: string[] = []
  for (let day = 1; day <= 75; day += 1) dates.push(`2026-${String(6 + Math.floor((day - 1) / 25)).padStart(2, '0')}-${String(((day - 1) % 25) + 1).padStart(2, '0')}`)
  const strategies = Array.from({ length: 12 }, (_, index) => `S${String(index).padStart(2, '0')}`)
  const symbols = Array.from({ length: 14 }, (_, index) => `${2300 + index}`)
  const canonical: Record<string, string> = {}
  const insertMatrix = db.prepare(`
    INSERT INTO strategy_label_matrix_v4 (
      signal_date, symbol, producer_run_id, strategy_id, strategy_version, strategy_status, alpha_bucket, family_id,
      production_owner, strategy_hit, evaluable, weak_label, affinity, position_weight, overlap,
      labeler_version, strategy_registry_checksum, reference_contract_version
    ) VALUES (?, ?, ?, ?, 'v1', 'active', 'core', 'fam', 0, ?, ?, 0, 0, 0, 0, ?, 'chk', ?)
  `)
  const insertRun = db.prepare(`
    INSERT INTO strategy_label_matrix_runs_v4 (
      producer_run_id, signal_date, status, reference_candidate_count, strategy_count, expected_cell_count,
      strategy_registry_checksum, labeler_version, reference_contract_version
    ) VALUES (?, ?, ?, 0, 0, 0, 'chk', ?, ?)
  `)
  const insertLabel = db.prepare(`
    INSERT INTO canonical_selection_labels_v4 (
      signal_date, symbol, label_schema_version, producer_run_id, entry_date, exit_date, outcome_known_date,
      entry_raw_open, exit_raw_close, entry_adjustment_factor, exit_adjustment_factor, gross_return, transaction_cost_bps,
      absolute_return_net, benchmark_return_net, benchmark_scope, residual_return_net, cross_section_rank,
      adjustment_source, reference_contract_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 0, 0, 0, 0, 'market', ?, 0, ?, ?)
  `)
  for (const [dateIndex, date] of dates.entries()) {
    const runs = [`run-${date}`, ...(random() < 0.4 ? [`alt-${date}`] : [])]
    if (random() < 0.9) canonical[date] = runs[Math.floor(random() * runs.length)]
    const dateStrategies = strategies.filter(() => random() < 0.8)
    for (const run of runs) {
      const contract = random() < 0.85 ? pick(CONTRACTS) : { referenceContractVersion: 'other-contract', labelerVersions: ['other-labeler'] }
      const labeler = random() < 0.9 ? pick(contract.labelerVersions) : 'stray-labeler'
      insertRun.run(run, date, random() < 0.85 ? 'ready' : 'failed', labeler, contract.referenceContractVersion)
      for (const symbol of symbols) {
        for (const strategy of dateStrategies) {
          // A few cells disagree with their run header (another compatible labeler or contract,
          // or a stray one): the run-header test must still be applied per cell.
          const deviation = random()
          const cellLabeler = deviation < 0.06 ? pick(pick(CONTRACTS).labelerVersions) : deviation < 0.09 ? 'stray-labeler' : labeler
          const cellContract = deviation >= 0.09 && deviation < 0.14 ? pick(CONTRACTS).referenceContractVersion : contract.referenceContractVersion
          insertMatrix.run(date, symbol, run, strategy, random() < 0.3 ? 1 : 0, random() < 0.7 ? 1 : 0, cellLabeler, cellContract)
        }
        // Most cells carry a label; its maturity decides whether the date counts.
        if (random() < 0.9) {
          const mature = dateIndex < 62 || random() < 0.2
          const known = mature ? '2026-11-01' : '2026-11-20'
          insertLabel.run(
            date, symbol, 'canonical-strategy-selection-label-v4', run, '2026-10-01', known, known,
            Math.round((random() - 0.5) * 2000) / 10000,
            random() < 0.85 ? CANONICAL_SELECTION_ADJUSTMENT_SOURCE : 'other-source',
            labelContract(random(), contract.referenceContractVersion),
          )
        }
      }
    }
  }
  return canonical
}

type Row = { strategy_id: string; signal_date: string; residual_return: number; sample_count: number }

function assertSameRows(actualRows: Row[], expectedRows: Row[], label: string): void {
  assert.equal(actualRows.length, expectedRows.length, label)
  for (const [index, expected] of expectedRows.entries()) {
    const actual = actualRows[index]
    assert.equal(actual.strategy_id, expected.strategy_id, `${label} row ${index}`)
    assert.equal(actual.signal_date, expected.signal_date, `${label} row ${index}`)
    assert.equal(Number(actual.sample_count), Number(expected.sample_count), `${label} row ${index}`)
    assert.ok(Math.abs(Number(actual.residual_return) - Number(expected.residual_return)) < 1e-12, `${label} row ${index}`)
  }
}

test('the strategy seek returns the same mature OOF rows as the date scan', () => {
  for (const seedValue of [7, 42, 20261106, 20261114]) {
    for (const withoutIndex of [undefined, 'idx_strategy_label_matrix_v4_oof_hits']) {
      const db = openDb({ withoutIndex })
      try {
        const canonical = seed(db, seedValue)
        const json = JSON.stringify(canonical)
        const legacy = db.prepare(legacySql).all(AS_OF, AS_OF, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, ...compat.binds, json) as Row[]
        const formerSeek = db.prepare(formerSeekSql).all(AS_OF, AS_OF, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, ...compat.binds, json) as Row[]
        const walkSeek = db.prepare(walkSeekSql).all(...walkSeekBinds(json)) as Row[]
        const seek = db.prepare(buildMatureStrategyOofReturnsSql(compat)).all(...currentBinds(json)) as Row[]
        const label = `seed ${seedValue}${withoutIndex ? ' without oof_hits' : ''}`
        assert.ok(legacy.length > 20, `${label} produced only ${legacy.length} rows`)
        assertSameRows(formerSeek, legacy, `${label} former seek`)
        assertSameRows(walkSeek, legacy, `${label} walk seek`)
        assertSameRows(seek, legacy, label)
      } finally {
        db.close()
      }
    }
  }
})

// The caller binds in the order the SQL expects: same output as the date scan through
// loadMatureStrategyOofReturns itself.
test('loadMatureStrategyOofReturns binds the seek correctly', async () => {
  for (const seedValue of [7, 20261114]) {
    const db = openDb()
    try {
      const canonical = seed(db, seedValue)
      const adapter = {
        prepare(sql: string) {
          let params: unknown[] = []
          return {
            bind(...values: unknown[]) { params = values; return this },
            async all() { return { results: db.prepare(sql).all(...(params as never[])) } },
          }
        },
      }
      const output = await loadMatureStrategyOofReturns(adapter as never, AS_OF, canonical)
      const legacy = db.prepare(legacySql).all(AS_OF, AS_OF, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, ...compat.binds, JSON.stringify(canonical)) as Row[]
      const flattened = Object.entries(output).flatMap(([strategyId, rows]) => rows.map((row) => ({ strategy_id: strategyId, ...row })))
      assert.ok(legacy.length > 20)
      assertSameRows(flattened, legacy, `seed ${seedValue} via caller`)
    } finally {
      db.close()
    }
  }
})

// counterfactual_production_effect is 0 in every row (CHECK), and only the OOF query repeats
// the term: any other hit-filtered matrix query keeps its own plan (e.g. a primary-key seek).
test('only the OOF query can use idx_strategy_label_matrix_v4_oof_hits', () => {
  assert.match(schema, /CHECK\(counterfactual_production_effect = 0\)/)
  const users: string[] = []
  for (const dir of ['src/lib', 'src/routes', 'src']) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      const text = readFileSync(`${dir}/${name}`, 'utf8')
      if (/counterfactual_production_effect\s*=\s*0\b/.test(text)) users.push(`${dir}/${name}`)
    }
  }
  assert.deepEqual(users, ['src/lib/marketScreener.ts'])
  // Without the term the seek no longer reaches the index.
  const db = openDb()
  try {
    const sql = buildMatureStrategyOofReturnsSql(compat)
    const without = sql.replace('AND m.counterfactual_production_effect=0', '')
    assert.notEqual(without, sql)
    assert.ok(!planOf(db, without).some((detail) => detail.includes('idx_strategy_label_matrix_v4_oof_hits')))
  } finally {
    db.close()
  }
})

// The run header is read once per canonical date instead of once per hit cell. These
// rewrites drop one part of the former per-cell EXISTS; each must change some result,
// which proves the seeds cover cells that disagree with their header, failed runs and
// incompatible contracts.
test('dropping any part of the hoisted run-header test changes the seeded result', () => {
  const sql = buildMatureStrategyOofReturnsSql(compat)
  const mutants: Array<[string, string, string]> = [
    ['no cell labeler check', 'AND m.labeler_version=s.labeler_version', ''],
    ['no cell contract check', 'AND m.reference_contract_version=s.reference_contract_version', ''],
    ['no ready status', "AND mr.status='ready'", ''],
    ['no compatibility', `AND ${compat.sql}`, ''],
    ['no canonical producer', 'AND m.producer_run_id=s.producer_run_id', ''],
  ]
  for (const [name, from, to] of mutants) {
    assert.equal(sql.split(from).length, 2, `${name}: anchor must occur once`)
    const mutated = sql.replace(from, to)
    const binds = name === 'no compatibility'
      ? (json: string) => [AS_OF, AS_OF, AS_OF, json, CANONICAL_SELECTION_ADJUSTMENT_SOURCE]
      : currentBinds
    let changed = false
    for (const seedValue of [7, 42, 20261106, 20261114]) {
      const db = openDb()
      try {
        const json = JSON.stringify(seed(db, seedValue))
        const expected = db.prepare(sql).all(...currentBinds(json)) as Row[]
        if (!sameRows(db.prepare(mutated).all(...binds(json)) as Row[], expected)) changed = true
      } finally {
        db.close()
      }
    }
    assert.ok(changed, `${name} must change some result`)
  }
})

function planOf(db: DatabaseSync, sql: string): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...currentBinds('{}')).map((row) => String(row.detail))
}

test('hit cells are read from the partial covering index, never from the matrix table', () => {
  const db = openDb()
  try {
    const plan = planOf(db, buildMatureStrategyOofReturnsSql(compat))
    const joined = plan.join(' | ')
    assert.ok(!plan.some((detail) => /^SCAN (m|l|mr|canonical_selection_labels_v4|strategy_label_matrix_v4|strategy_label_matrix_runs_v4)\b/.test(detail)), joined)
    // Strategy enumeration: one seek per step on an index led by (signal_date, strategy_id).
    assert.ok(plan.some((detail) => /SEARCH m USING COVERING INDEX idx_strategy_label_matrix_\w+ \(signal_date=\? AND strategy_id>\?\)/.test(detail)), joined)
    // Hits: equality on date, strategy, canonical producer, contract and labeler, covering:
    // only that producer's hit entries are read and no matrix table row is.
    assert.ok(plan.some((detail) => detail === 'SEARCH m USING COVERING INDEX idx_strategy_label_matrix_v4_oof_hits (signal_date=? AND strategy_id=? AND producer_run_id=? AND reference_contract_version=? AND labeler_version=?)'), joined)
    assert.ok(!plan.some((detail) => /^SEARCH m USING INDEX /.test(detail)), joined)
    // The run header once per canonical date, by primary key; never per hit cell.
    assert.ok(plan.some((detail) => /^SEARCH mr USING INDEX \w+ \(producer_run_id=\?/.test(detail)), joined)
    assert.ok(!plan.some((detail) => /EXISTS/.test(detail)), joined)
    // Labels by primary key; mature dates walk the primary key newest first without a sort.
    assert.ok(plan.some((detail) => /SEARCH l USING (INDEX sqlite_autoindex_canonical_selection_labels_v4_1|PRIMARY KEY) \(signal_date=\? AND symbol=\? AND producer_run_id=\?/.test(detail)), joined)
    assert.ok(plan.some((detail) => /SEARCH canonical_selection_labels_v4 USING (INDEX sqlite_autoindex_canonical_selection_labels_v4_1|PRIMARY KEY) \(signal_date<\?\)/.test(detail)), joined)
    assert.ok(!plan.some((detail) => /TEMP B-TREE FOR ORDER BY/.test(detail)), joined)
  } finally {
    db.close()
  }
})

test('without learning 0069 the plan falls back to the former hit seek, not a date scan', () => {
  const db = openDb({ withoutIndex: 'idx_strategy_label_matrix_v4_oof_hits' })
  try {
    const plan = planOf(db, buildMatureStrategyOofReturnsSql(compat))
    const joined = plan.join(' | ')
    assert.ok(!plan.some((detail) => /^SCAN (m|l|mr|canonical_selection_labels_v4|strategy_label_matrix_v4)\b/.test(detail)), joined)
    assert.ok(plan.some((detail) => /SEARCH m USING INDEX idx_strategy_label_matrix_v4_evaluable \(signal_date=\? AND strategy_id=\? AND evaluable=\? AND strategy_hit=\?\)/.test(detail)), joined)
  } finally {
    db.close()
  }
})

test('learning 0069 creates exactly the oof_hits index of the schema', () => {
  const migration = readFileSync('domain-migrations/learning/0069_oof_hits_and_audit_json_pending_indexes.sql', 'utf8')
  const pick = (text: string) => text.match(/CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_v4_oof_hits[^;]*;/)?.[0].replace(/\s+/g, ' ')
  assert.ok(pick(migration))
  assert.equal(pick(migration), pick(schema))
})

// Mature-date edge cases: maturity scattered over every date (fully mature, mixed, fully
// immature, mature only through another label schema, unlabelled), and 0 / <60 / exactly
// 60 / exactly 61 / >61 mature dates. The mutants prove the seeds can tell the bounded
// recursive walk from plausible wrong rewrites of it.
const DATE_KINDS = ['mature', 'mixed', 'immature', 'other_schema_mature', 'unlabelled'] as const

function seedMaturity(db: DatabaseSync, seedValue: number, totalDates: number, matureDates: number): string {
  const random = rng(seedValue)
  const contract = CONTRACTS[0]
  const labeler = contract.labelerVersions[0]
  const insertMatrix = db.prepare(`
    INSERT INTO strategy_label_matrix_v4 (
      signal_date, symbol, producer_run_id, strategy_id, strategy_version, strategy_status, alpha_bucket, family_id,
      production_owner, strategy_hit, evaluable, weak_label, affinity, position_weight, overlap,
      labeler_version, strategy_registry_checksum, reference_contract_version
    ) VALUES (?, ?, ?, ?, 'v1', 'active', 'core', 'fam', 0, ?, 1, 0, 0, 0, 0, ?, 'chk', ?)
  `)
  const insertRun = db.prepare(`
    INSERT INTO strategy_label_matrix_runs_v4 (
      producer_run_id, signal_date, status, reference_candidate_count, strategy_count, expected_cell_count,
      strategy_registry_checksum, labeler_version, reference_contract_version
    ) VALUES (?, ?, 'ready', 0, 0, 0, 'chk', ?, ?)
  `)
  const insertLabel = db.prepare(`
    INSERT INTO canonical_selection_labels_v4 (
      signal_date, symbol, label_schema_version, producer_run_id, entry_date, exit_date, outcome_known_date,
      entry_raw_open, exit_raw_close, entry_adjustment_factor, exit_adjustment_factor, gross_return, transaction_cost_bps,
      absolute_return_net, benchmark_return_net, benchmark_scope, residual_return_net, cross_section_rank,
      adjustment_source, reference_contract_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 0, 0, 0, 0, 'market', ?, 0, ?, ?)
  `)
  const dates = Array.from({ length: totalDates }, (_, index) => new Date(Date.UTC(2026, 2, 1) + index * 86_400_000).toISOString().slice(0, 10))
  // Exactly matureDates of the dates are mature or mixed; the rest are scattered over the other kinds.
  const order = dates.map((date) => ({ date, key: random() })).sort((left, right) => left.key - right.key)
  const kindByDate = new Map(order.map(({ date }, index) => [
    date,
    index < matureDates
      ? (random() < 0.5 ? 'mature' : 'mixed')
      : DATE_KINDS[2 + Math.floor(random() * 3)],
  ]))
  const canonical: Record<string, string> = {}
  for (const date of dates) {
    const kind = kindByDate.get(date)!
    const runs = [`run-${date}`, `alt-${date}`]
    canonical[date] = runs[Math.floor(random() * runs.length)]
    for (const run of runs) {
      insertRun.run(run, date, labeler, contract.referenceContractVersion)
      for (let symbolIndex = 0; symbolIndex < 8; symbolIndex += 1) {
        const symbol = `${2300 + symbolIndex}`
        for (const strategy of ['S1', 'S2']) {
          insertMatrix.run(date, symbol, run, strategy, random() < 0.8 ? 1 : 0, labeler, contract.referenceContractVersion)
        }
        if (kind === 'unlabelled') continue
        // One mature row is enough for a mixed date; the as-of date itself counts as known.
        const mature = kind === 'mature' || (kind === 'mixed' && (symbolIndex === 0 || random() < 0.4))
        const known = mature ? (random() < 0.3 ? AS_OF : '2026-11-01') : '2026-11-20'
        insertLabel.run(
          date, symbol, 'canonical-strategy-selection-label-v4', run, '2026-10-01', known, known,
          Math.round((random() - 0.5) * 2000) / 10000, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, contract.referenceContractVersion,
        )
        // Schema noise: other-schema rows that are mature, including on dates whose canonical rows are not.
        if (kind === 'other_schema_mature' || random() < 0.3) {
          insertLabel.run(
            date, symbol, 'other-label-schema', run, '2026-10-01', '2026-11-01', '2026-11-01',
            0.5, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, contract.referenceContractVersion,
          )
        }
      }
    }
  }
  return JSON.stringify(canonical)
}

const MATURITY_SCENARIOS = [
  [0, 0], [1, 1], [12, 0], [30, 20], [75, 59], [80, 60], [85, 61], [95, 62], [130, 90],
] as const

function maturityRuns(sql: string): Array<{ label: string; former: Row[]; actual: Row[] }> {
  const out: Array<{ label: string; former: Row[]; actual: Row[] }> = []
  for (const [totalDates, matureDates] of MATURITY_SCENARIOS) {
    for (const seedValue of [11, 2026]) {
      const db = openDb()
      try {
        const json = seedMaturity(db, seedValue * 1000 + totalDates, totalDates, matureDates)
        out.push({
          label: `dates=${totalDates} mature=${matureDates} seed=${seedValue}`,
          former: db.prepare(formerSeekSql).all(AS_OF, AS_OF, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, ...compat.binds, json) as Row[],
          actual: db.prepare(sql).all(...currentBinds(json)) as Row[],
        })
      } finally {
        db.close()
      }
    }
  }
  return out
}

function sameRows(left: Row[], right: Row[]): boolean {
  try {
    assertSameRows(left, right, '')
    return true
  } catch {
    return false
  }
}

test('the mature-date walk matches the DISTINCT scan for 0, <60, 60, 61 and >61 mature dates', () => {
  const runs = maturityRuns(buildMatureStrategyOofReturnsSql(compat))
  for (const { label, former, actual } of runs) assertSameRows(actual, former, label)
  // Every scenario with mature dates yields rows, so a dropped or extra date is visible.
  for (const { label, former } of runs) {
    if (!/mature=0 /.test(label)) assert.ok(former.length > 0, label)
  }
  const distinctDates = (rows: Row[]) => new Set(rows.map((row) => row.signal_date)).size
  assert.ok(runs.some(({ label, former }) => /mature=61 /.test(label) && distinctDates(former) === 60), 'the 61-date case must hit the LIMIT')
})

test('plausible wrong rewrites of the mature-date walk fail the maturity seeds', () => {
  const sql = buildMatureStrategyOofReturnsSql(compat)
  const mutants: Array<[string, string, string]> = [
    ['limit 61', 'd.n < 60', 'd.n < 61'],
    ['no maturity filter in the recursive step', 'WHERE +l.outcome_known_date <= ?', 'WHERE (+l.outcome_known_date <= ? OR 1)'],
    [
      'no schema filter in the recursive step',
      "AND l.label_schema_version = 'canonical-strategy-selection-label-v4'), d.n + 1",
      'AND 1), d.n + 1',
    ],
  ]
  for (const [name, from, to] of mutants) {
    assert.equal(sql.split(from).length, 2, `${name}: anchor must occur once`)
    const runs = maturityRuns(sql.replace(from, to))
    assert.ok(runs.some(({ former, actual }) => !sameRows(actual, former)), `${name} must change some result`)
  }
})
