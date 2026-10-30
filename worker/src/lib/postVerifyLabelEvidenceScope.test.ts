import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { capturePostVerifyLabelEvidence, verifyPostVerifyLabelEvidence } from './postVerifyLabelEvidence'
import { PRICE_HORIZON_PROJECTION_VERSION as v1, STRATEGY_MULTI_HORIZON_PROJECTION_VERSION as v2,
  PRICE_HORIZON_SOURCE as source } from './priceHorizonProjection'
import { SELECTION_REFERENCE_CONTRACT_VERSION as contract } from './selectionReferenceEvidence'
import { STRATEGY_MULTI_HORIZON_OUTCOME_SCHEMA_VERSION as outcomeSchema } from './strategyMultiHorizonOutcomes'

// NEW-1030-22 (proof v2): row-level proof only for the keys whose status was written on or after the business
// date (plus the producer's processed keys), the rest of the 120-day window by SQL GROUP BY counts reconciled
// against status/producer counts.
const businessDate = '2026-10-16', sha = 'a'.repeat(40)
const shift = (date: string, days: number) => {
  const value = new Date(date + 'T00:00:00Z'); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10)
}
// 10/29 measured: 9 processed groups ~7.4k label rows against ~174k label rows in the window (4.25%).
// Scaled down: 53 signal dates x 40 stocks, 1 v1 + 3 v2 horizons = 8,480 label rows; 9 keys x 40 = 360.
const DATES = 53, STOCKS = 40
const signals = Array.from({ length: DATES }, (_, index) => shift('2026-10-10', index - DATES + 1))
const processedDates = signals.slice(-3)
// Status rows of the processed dates were written tonight; every other date on an earlier night.
const writtenAt = (signal: string) => processedDates.includes(signal) ? `${businessDate} 10:00:00` : `${shift(signal, 3)} 12:00:00`

type Reads = Map<string, number>
// dates: a longer window of signal dates; allTonight: every status row written tonight (all keys in row scope).
function fixture(options: { retry?: boolean; dates?: number; allTonight?: boolean } = {}) {
  const sql = new DatabaseSync(':memory:')
  const sigs = options.dates ? Array.from({ length: options.dates }, (_, index) => shift('2026-10-10', index - options.dates! + 1)) : signals
  const nDates = sigs.length, tonight = `${businessDate} 10:00:00`
  const extract = (file: string, table: string) => {
    const text = readFileSync(file, 'utf8'), match = text.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
    assert.ok(match, table); sql.exec(match[0])
  }
  for (const name of ['price_horizon_labels_v1', 'price_horizon_label_rejections_v1']) extract('domain-migrations/learning/0001_learning_baseline.sql', name)
  for (const name of ['price_horizon_labels_v2', 'price_horizon_label_rejections_v2', 'canonical_selection_outcomes_v1']) extract('domain-migrations/learning/0011_strategy_multi_horizon_outcomes.sql', name)
  for (const name of ['price_horizon_projection_status', 'price_horizon_projection_runs']) extract('domain-migrations/ops/0001_ops_baseline.sql', name)
  extract('domain-migrations/ops/0007_strategy_multi_horizon_projection_status.sql', 'price_horizon_projection_status_v2')
  extract('domain-migrations/ops/0005_ops_artifact_compute_cost_runtime.sql', 'canonical_run_heads')
  sql.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8'))
  sql.exec(`CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,lease_expires_at TEXT);
    CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,stock_id INTEGER,
      market_segment TEXT,sector TEXT,feature_contract_version TEXT,hard_gate_passed INTEGER,
      PRIMARY KEY(signal_date,symbol,producer_run_id));`)
  // The real indexes of the read tables (the reference table here is reduced; indexes on absent columns are skipped).
  for (const file of ['domain-migrations/learning/0001_learning_baseline.sql', 'domain-migrations/learning/0011_strategy_multi_horizon_outcomes.sql']) {
    for (const index of readFileSync(file, 'utf8').match(/CREATE INDEX IF NOT EXISTS \w+\s+ON (price_horizon_label\w*_v[12]|canonical_selection_outcomes_v1|selection_reference_snapshots_v1)\([^;]*\);/g) ?? []) {
      try { sql.exec(index) } catch { /* column not in the reduced reference table */ }
    }
  }
  sql.prepare('INSERT INTO pipeline_stage_runs VALUES(?,?,?,?,?)').run(businessDate, 'post_verify_chain', 'finlab-A', 'running', '2099-01-01')
  sql.prepare(`INSERT INTO scheduler_execution_tickets_v1
    (ticket_id,dedupe_key,root_ticket_id,scheduler_job_id,task,business_date,run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum,updated_at)
    VALUES('root-A','root-A','root-A','evening-chain','evening-chain',?,'physical-evening','attempt','physical_root','running','scheduler_http','checksum','2026-10-16 00:00:00')`)
    .run(businessDate)
  sql.prepare(`INSERT INTO price_horizon_projection_runs(run_id,start_date,end_date,outcome_as_of_date,eligible_signal_dates,
    processed_signal_dates,candidate_count,materialized_count,rejected_count,status,completed_at)
    VALUES('projection-A',?,?,?,0,0,0,0,0,'success','2026-10-16 01:00:00')`).run(shift(businessDate, -120), businessDate, businessDate)
  const label1 = sql.prepare(`INSERT INTO price_horizon_labels_v1(stock_id,price_date,entry_date,entry_raw_open,entry_adjustment_factor,
    exit_date,exit_raw_close,exit_adjustment_factor,outcome_known_date,source,projection_version) VALUES(?,?,?,10,1,?,11,1,?,?,?)`)
  const label2 = sql.prepare(`INSERT INTO price_horizon_labels_v2(stock_id,price_date,horizon_days,entry_date,entry_raw_open,entry_adjustment_factor,
    exit_date,exit_raw_close,exit_adjustment_factor,outcome_known_date,source,projection_version) VALUES(?,?,?,?,10,1,?,11,1,?,?,?)`)
  const reference = sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES(?,?,?,?,?,?,?,1)')
  const outcome = sql.prepare(`INSERT INTO canonical_selection_outcomes_v1(signal_date,symbol,producer_run_id,horizon_days,label_schema_version,
    market_segment,sector,entry_date,exit_date,outcome_known_date,gross_return,transaction_cost_bps,absolute_return_net,
    benchmark_return_net,benchmark_scope,residual_return_net,cross_section_rank,adjustment_source,reference_contract_version)
    VALUES(?,?,?,?,?,'listed','sector',?,?,?,.1,18,.0982,.04,'market',.0582,.5,'price_horizon_labels_v2:finlab_primary_canonical_mirror',?)`)
  sql.exec('BEGIN')
  for (const signal of sigs) {
    const entry = shift(signal, 1), exit = shift(signal, 2), producer = `screener-${signal}`
    sql.prepare('INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES(?,?,?)')
      .run(`screener:${signal}:TW:production:market_screener`, producer, signal)
    sql.prepare(`INSERT INTO price_horizon_projection_status(signal_date,entry_date,exit_date,candidate_count,materialized_count,
      rejected_count,status,source,projection_version,updated_at) VALUES(?,?,?,?,?,0,'success',?,?,?)`)
      .run(signal, entry, exit, STOCKS, STOCKS, source, v1, options.allTonight ? tonight : `${shift(signal, 3)} 12:00:00`)
    for (let id = 1; id <= STOCKS; id++) {
      label1.run(id, signal, entry, exit, exit, source, v1)
      reference.run(signal, String(id), producer, id, 'listed', 'sector', contract)
      for (const horizon of [3, 5, 10]) {
        label2.run(id, signal, horizon, entry, exit, exit, source, v2)
        outcome.run(signal, String(id), producer, horizon, outcomeSchema, entry, exit, exit, contract)
      }
    }
    for (const horizon of [3, 5, 10]) sql.prepare(`INSERT INTO price_horizon_projection_status_v2(signal_date,horizon_days,entry_date,exit_date,
      candidate_count,materialized_count,rejected_count,status,source,projection_version,updated_at) VALUES(?,?,?,?,?,?,0,'success',?,?,?)`)
      .run(signal, horizon, entry, exit, STOCKS, STOCKS, source, v2, options.allTonight ? tonight : writtenAt(signal))
  }
  sql.exec('COMMIT')
  // Rows returned per table, split into row-level page reads and GROUP BY count reads; every query is recorded.
  const reads: Reads = new Map(), queries: Array<{ query: string; values: any[] }> = []
  let readHook: ((query: string, rows: any[]) => any[]) | null = null
  const db = { prepare(query: string) {
    let values: any[] = []
    const st = { bind(...args: any[]) { values = args; return st },
      async all() {
        queries.push({ query, values })
        let results = sql.prepare(query).all(...values) as any[]
        const grouped = /GROUP BY/.test(query), table = query.match(/FROM\s+(\w+)/)?.[1] ?? '?'
        if (readHook) results = readHook(query, results)
        const key = `${grouped ? 'group' : 'rows'}:${table}`
        reads.set(key, (reads.get(key) ?? 0) + results.length)
        return { success: true, results }
      },
      async first() { queries.push({ query, values }); return sql.prepare(query).get(...values) ?? null },
      async run() { throw new Error('readback attempted write') } }
    return st
  } }
  const env = { DB: db, CF_VERSION_METADATA: { tag: sha, id: 'version-A' } } as any
  const multiKeys = processedDates.flatMap(signalDate => [3, 5, 10].map(horizonDays => ({ signalDate, horizonDays })))
  const canonical = { runId: 'projection-A', eligibleSignalDates: 0, processedSignalDates: 0, skippedCompleteDates: nDates,
    deferredSignalDates: 0, candidateCount: 0, materializedCount: 0, rejectedCount: 0, breadthMaterializedCount: 0,
    status: 'success' as const, summary: 'terminal', processedHorizonKeys: [] as Array<{ signalDate: string; horizonDays: number }> }
  // A retry: an earlier attempt finished the 9 keys, so this producer run skipped them all.
  const multiHorizon = options.retry
    ? { horizons: [3, 5, 10], eligibleSignalDates: 9, processedSignalDates: 0, skippedCompleteDates: 9, deferredSignalDates: 0,
      candidateCount: 0, materializedCount: 0, rejectedCount: 0, status: 'success' as const, summary: 'terminal', processedHorizonKeys: [] }
    : { horizons: [3, 5, 10], eligibleSignalDates: 9, processedSignalDates: 9, skippedCompleteDates: 0,
      deferredSignalDates: 0, candidateCount: 9 * STOCKS, materializedCount: 9 * STOCKS, rejectedCount: 0,
      status: 'success' as const, summary: 'terminal', processedHorizonKeys: multiKeys }
  const outcomes = { asOfDate: businessDate, referenceRows: nDates * STOCKS, horizons: [3, 5, 10].map(horizonDays => ({ horizonDays,
    matureRows: nDates * STOCKS, pendingRows: 0, unavailableRows: 0, persistedRows: nDates * STOCKS, retiredRows: 0 })), summary: 'terminal' }
  const input = { businessDate, canonicalRunId: 'finlab-A', projectionRunId: 'projection-A',
    producerResult: { canonical, multiHorizon, outcomes } }
  const projection = { ...input, task: 'price-horizon-projection' as const }
  const outcomeInput = { ...input, task: 'strategy-multi-horizon-outcomes' as const }
  return { sql, env, reads, queries, projection, outcomeInput, hook: (fn: typeof readHook) => { readHook = fn } }
}
const rowsRead = (reads: Reads, tables: string[]) => tables.reduce((sum, table) => sum + (reads.get(`rows:${table}`) ?? 0), 0)
const count = (f: ReturnType<typeof fixture>, table: string) => (f.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n as number
const LABEL_TABLES = ['price_horizon_labels_v1', 'price_horizon_label_rejections_v1', 'price_horizon_labels_v2', 'price_horizon_label_rejections_v2']

test('v2 projection proof reads only the processed keys row by row; the window is counted once', async () => {
  const f = fixture()
  const proof = await capturePostVerifyLabelEvidence(f.env, f.projection)
  assert.equal(proof.schema, 'post-verify-label-evidence-v2')
  const windowRows = LABEL_TABLES.reduce((sum, table) => sum + count(f, table), 0)
  assert.equal(windowRows, DATES * STOCKS * 4, 'v1 read every label row of the window row by row')
  // Only the 9 processed date x horizon groups are read row by row: 360 of 8,480 rows (4.25%).
  assert.equal(rowsRead(f.reads, LABEL_TABLES), 9 * STOCKS)
  assert.ok(rowsRead(f.reads, LABEL_TABLES) / windowRows < 0.05)
  // The rest of the window: one row per date (x horizon) from GROUP BY, plus the (small) status tables.
  assert.equal(f.reads.get('group:price_horizon_labels_v1'), DATES)
  assert.equal(f.reads.get('group:price_horizon_labels_v2'), DATES * 3)
  assert.equal(f.reads.get('rows:price_horizon_projection_status_v2'), DATES * 3)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, JSON.parse(JSON.stringify(proof))), true)
  // Counter: a processed row's content changed -> not verified (row-level hash).
  f.sql.exec(`UPDATE price_horizon_labels_v2 SET exit_raw_close=12 WHERE stock_id=1 AND price_date='${processedDates[0]}' AND horizon_days=5`)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof), false)
  f.sql.close()
})

test('v2 projection: an unprocessed group whose count disagrees with its status fails closed', async () => {
  const f = fixture()
  const proof = await capturePostVerifyLabelEvidence(f.env, f.projection)
  // Accepted scope (Wei 10/30): same-count content change outside the processed keys is not re-hashed.
  f.sql.exec(`UPDATE price_horizon_labels_v2 SET exit_raw_close=12 WHERE stock_id=1 AND price_date='${signals[0]}' AND horizon_days=5`)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof), true)
  // A label row gone from an old (unprocessed) group: the window count no longer matches its status row.
  f.sql.exec(`DELETE FROM price_horizon_labels_v2 WHERE stock_id=2 AND price_date='${signals[0]}' AND horizon_days=3`)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, f.projection), new RegExp(`label_count_mismatch:2:${signals[0]}:3`))
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof), false)
  // Counter: the same removal with its status row updated reconciles (a fresh capture passes), while the
  // earlier receipt no longer verifies because the window counts are part of its checksum.
  f.sql.exec(`UPDATE price_horizon_projection_status_v2 SET candidate_count=candidate_count-1,materialized_count=materialized_count-1
    WHERE signal_date='${signals[0]}' AND horizon_days=3`)
  assert.equal((await capturePostVerifyLabelEvidence(f.env, f.projection)).schema, 'post-verify-label-evidence-v2')
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof), false)
  f.sql.close()
})

test('v2 projection: labels of an unprocessed date without a status row fail closed', async () => {
  const f = fixture()
  f.sql.exec(`DELETE FROM price_horizon_projection_status WHERE signal_date='${signals[5]}'`)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, f.projection), new RegExp(`label_status_missing:1:${signals[5]}:5`))
  const h = fixture()
  h.sql.exec(`DELETE FROM price_horizon_projection_status_v2 WHERE signal_date='${signals[7]}' AND horizon_days=10`)
  await assert.rejects(capturePostVerifyLabelEvidence(h.env, h.projection), new RegExp(`label_status_missing:2:${signals[7]}:10`))
  h.sql.close()
  // Counter: a status row with zero labels and zero counts is consistent (nothing to miss).
  const g = fixture()
  g.sql.prepare(`INSERT INTO price_horizon_projection_status(signal_date,entry_date,exit_date,candidate_count,materialized_count,
    rejected_count,status,source,projection_version) VALUES(?,?,?,0,0,0,'success',?,?)`).run(shift(signals[0], -1), signals[0], shift(signals[0], 1), source, v1)
  assert.equal((await capturePostVerifyLabelEvidence(g.env, g.projection)).schema, 'post-verify-label-evidence-v2')
  f.sql.close(); g.sql.close()
})

test('v2 outcomes proof: processed keys row by row, window counts reconcile the producer totals', async () => {
  const f = fixture()
  const proof = await capturePostVerifyLabelEvidence(f.env, f.outcomeInput)
  const tables = ['selection_reference_snapshots_v1', 'price_horizon_labels_v2', 'canonical_selection_outcomes_v1']
  const windowRows = tables.reduce((sum, table) => sum + count(f, table), 0)
  assert.equal(windowRows, DATES * STOCKS * 7)
  assert.equal(rowsRead(f.reads, tables), 3 * STOCKS + 9 * STOCKS + 9 * STOCKS)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, JSON.parse(JSON.stringify(proof))), true)
  // An outcome of an old (unprocessed) date disappears: persisted rows no longer match the producer.
  f.sql.exec(`DELETE FROM canonical_selection_outcomes_v1 WHERE signal_date='${signals[0]}' AND symbol='1' AND horizon_days=10`)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, f.outcomeInput), /outcome_count_mismatch/)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof), false)
  f.sql.close()
})

test('v2 outcomes: a reference gone from an unprocessed date changes the window total and fails', async () => {
  const f = fixture()
  f.sql.exec(`DELETE FROM selection_reference_snapshots_v1 WHERE signal_date='${signals[2]}' AND symbol='4'`)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, f.outcomeInput), /outcome_expected_missing/)
  // Counter: a reference of a non-head producer is outside the canonical counts.
  const g = fixture()
  g.sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES(?,?,?,?,?,?,?,1)').run(signals[2], '1', 'screener-other', 1, 'listed', 'sector', contract)
  assert.equal((await capturePostVerifyLabelEvidence(g.env, g.outcomeInput)).schema, 'post-verify-label-evidence-v2')
  f.sql.close(); g.sql.close()
})

test('v2: scope rows that disagree with the window count in one capture are a concurrent change', async () => {
  const f = fixture()
  // The window count of a scope key moves together with its status row (so the status check passes), but
  // the key's row read does not see the extra row: the tables changed under this capture.
  const bump = (query: string, rows: any[]) => /GROUP BY/.test(query) && /FROM price_horizon_labels_v2/.test(query)
    ? rows.map(row => row.price_date === processedDates[0] && row.horizon_days === 5 ? { ...row, n: row.n + 1 } : row)
    : /FROM price_horizon_projection_status_v2/.test(query) && !/COUNT/.test(query)
      ? rows.map(row => row.signal_date === processedDates[0] && row.horizon_days === 5
        ? { ...row, candidate_count: row.candidate_count + 1, materialized_count: row.materialized_count + 1 } : row)
      : rows
  f.hook(bump)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, f.projection), new RegExp(`concurrent_change:2:${processedDates[0]}:5`))
  f.hook(null)
  const proof = await capturePostVerifyLabelEvidence(f.env, f.projection)
  f.hook(bump)
  // A concurrent change is a read problem: verification throws instead of requesting a producer rerun.
  await assert.rejects(verifyPostVerifyLabelEvidence(f.env, proof), /concurrent_change/)
  // Outcomes: an outcome row counted in the window but absent from its key's row read.
  f.hook((query, rows) => /GROUP BY/.test(query) && /FROM canonical_selection_outcomes_v1 o/.test(query)
    ? rows.map(row => row.signal_date === processedDates[1] && row.horizon_days === 3 ? { ...row, n_all: row.n_all + 1 } : row) : rows)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, f.outcomeInput), new RegExp(`concurrent_change:${processedDates[1]}:3`))
  // References: a scope date's window count disagrees with its row read (checked before the producer totals).
  f.hook((query, rows) => /GROUP BY signal_date,producer_run_id/.test(query)
    ? rows.map(row => row.signal_date === processedDates[2] ? { ...row, n: row.n + 1 } : row) : rows)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, f.outcomeInput), new RegExp(`concurrent_change:${processedDates[2]}$`))
  f.sql.close()
})

test('v2 retry: keys an earlier attempt finished stay row-proven through their status rows', async () => {
  // The producer skipped every key (processed keys empty), but their status rows were written tonight.
  const f = fixture({ retry: true })
  const proof = await capturePostVerifyLabelEvidence(f.env, f.projection)
  assert.equal(rowsRead(f.reads, LABEL_TABLES), 9 * STOCKS)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, JSON.parse(JSON.stringify(proof))), true)
  f.sql.exec(`UPDATE price_horizon_labels_v2 SET exit_raw_close=12 WHERE stock_id=3 AND price_date='${processedDates[2]}' AND horizon_days=10`)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof), false)
  // Outcomes take the same keys from the status rows (no producer keys are passed).
  const g = fixture({ retry: true })
  await capturePostVerifyLabelEvidence(g.env, g.outcomeInput)
  assert.equal(rowsRead(g.reads, ['price_horizon_labels_v2', 'canonical_selection_outcomes_v1']), 2 * 9 * STOCKS)
  // Counter: status rows written before the business date put nothing in row scope; the window counts remain.
  const h = fixture({ retry: true })
  h.sql.exec(`UPDATE price_horizon_projection_status_v2 SET updated_at='${shift(businessDate, -1)} 23:59:59'`)
  const counted = await capturePostVerifyLabelEvidence(h.env, h.projection)
  assert.equal(rowsRead(h.reads, LABEL_TABLES), 0)
  assert.equal(await verifyPostVerifyLabelEvidence(h.env, counted), true)
  f.sql.close(); g.sql.close(); h.sql.close()
})

test('v2 outcomes: every window outcome row is counted, including retained and non-head rows', async () => {
  const f = fixture()
  // A non-head producer's outcome and a retained outcome whose label is gone (unavailable input) on old dates.
  f.sql.prepare(`INSERT INTO canonical_selection_outcomes_v1(signal_date,symbol,producer_run_id,horizon_days,label_schema_version,
    entry_date,exit_date,outcome_known_date,gross_return,transaction_cost_bps,absolute_return_net,benchmark_return_net,benchmark_scope,
    residual_return_net,cross_section_rank,adjustment_source,reference_contract_version)
    VALUES(?,'1','screener-other',5,?,?,?,?,.1,18,.0982,.04,'market',.0582,.5,'x',?)`)
    .run(signals[4], outcomeSchema, shift(signals[4], 1), shift(signals[4], 2), shift(signals[4], 2), contract)
  f.sql.exec(`DELETE FROM price_horizon_labels_v2 WHERE stock_id=7 AND price_date='${signals[6]}' AND horizon_days=3`)
  f.sql.exec(`UPDATE price_horizon_projection_status_v2 SET candidate_count=candidate_count-1,materialized_count=materialized_count-1
    WHERE signal_date='${signals[6]}' AND horizon_days=3`)
  const input = structuredClone(f.outcomeInput)
  input.producerResult.outcomes.horizons[0] = { ...input.producerResult.outcomes.horizons[0],
    matureRows: DATES * STOCKS - 1, persistedRows: DATES * STOCKS - 1, unavailableRows: 1 }
  const proof = await capturePostVerifyLabelEvidence(f.env, input)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, JSON.parse(JSON.stringify(proof))), true)
  // Either row disappearing changes no producer total, but the saved window counts no longer verify.
  f.sql.exec(`DELETE FROM canonical_selection_outcomes_v1 WHERE producer_run_id='screener-other'`)
  assert.equal((await capturePostVerifyLabelEvidence(f.env, input)).schema, 'post-verify-label-evidence-v2')
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof), false)
  const proof2 = await capturePostVerifyLabelEvidence(f.env, input)
  f.sql.exec(`DELETE FROM canonical_selection_outcomes_v1 WHERE signal_date='${signals[6]}' AND symbol='7' AND horizon_days=3`)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof2), false)
  // Counter: nothing changed -> the same receipt verifies.
  const proof3 = await capturePostVerifyLabelEvidence(f.env, input)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof3), true)
  // A non-head outcome inside a row-scope key: its row read and the all-producer window count agree.
  f.sql.prepare(`INSERT INTO canonical_selection_outcomes_v1(signal_date,symbol,producer_run_id,horizon_days,label_schema_version,
    entry_date,exit_date,outcome_known_date,gross_return,transaction_cost_bps,absolute_return_net,benchmark_return_net,benchmark_scope,
    residual_return_net,cross_section_rank,adjustment_source,reference_contract_version)
    VALUES(?,'1','screener-other',10,?,?,?,?,.1,18,.0982,.04,'market',.0582,.5,'x',?)`)
    .run(processedDates[0], outcomeSchema, shift(processedDates[0], 1), shift(processedDates[0], 2), shift(processedDates[0], 2), contract)
  assert.equal((await capturePostVerifyLabelEvidence(f.env, input)).schema, 'post-verify-label-evidence-v2')
  f.sql.close()
})

test('v2 outcomes: pending labels (known after the business date) reconcile against pendingRows', async () => {
  const f = fixture()
  // A newer signal date whose exits fall after the business date: references and labels exist, no outcomes.
  const signal = shift(businessDate, -1), entry = shift(signal, 1), exit = shift(signal, 4), producer = `screener-${signal}`
  f.sql.prepare('INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES(?,?,?)')
    .run(`screener:${signal}:TW:production:market_screener`, producer, signal)
  for (let id = 1; id <= STOCKS; id++) {
    f.sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES(?,?,?,?,?,?,?,1)').run(signal, String(id), producer, id, 'listed', 'sector', contract)
    for (const horizon of [3, 5, 10]) f.sql.prepare(`INSERT INTO price_horizon_labels_v2(stock_id,price_date,horizon_days,entry_date,entry_raw_open,
      entry_adjustment_factor,exit_date,exit_raw_close,exit_adjustment_factor,outcome_known_date,source,projection_version)
      VALUES(?,?,?,?,10,1,?,11,1,?,?,?)`).run(id, signal, horizon, entry, exit, exit, source, v2)
  }
  for (const horizon of [3, 5, 10]) f.sql.prepare(`INSERT INTO price_horizon_projection_status_v2(signal_date,horizon_days,entry_date,exit_date,
    candidate_count,materialized_count,rejected_count,status,source,projection_version,updated_at) VALUES(?,?,?,?,?,?,0,'success',?,?,?)`)
    .run(signal, horizon, entry, exit, STOCKS, STOCKS, source, v2, `${businessDate} 10:00:00`)
  const input = structuredClone(f.outcomeInput)
  input.producerResult.outcomes.referenceRows = (DATES + 1) * STOCKS
  input.producerResult.outcomes.horizons = input.producerResult.outcomes.horizons.map(row => ({ ...row, pendingRows: STOCKS }))
  const proof = await capturePostVerifyLabelEvidence(f.env, input)
  // The pending key is in row scope (status written tonight): its labels are read row by row.
  assert.ok(proof.rowScope['outcomes-v2'].includes(`${signal}:10`))
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, JSON.parse(JSON.stringify(proof))), true)
  // Counter: a producer that reported no pending rows does not reconcile.
  const wrong = structuredClone(input)
  wrong.producerResult.outcomes.horizons = wrong.producerResult.outcomes.horizons.map(row => ({ ...row, pendingRows: 0 }))
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, wrong), /outcome_count_mismatch/)
  f.sql.close()
})

test('v2 row reads use one index search per key (no full scan, no MULTI-INDEX OR)', async () => {
  const f = fixture()
  await capturePostVerifyLabelEvidence(f.env, f.projection)
  await capturePostVerifyLabelEvidence(f.env, f.outcomeInput)
  const read = /FROM (price_horizon_label\w*_v[12]|canonical_selection_outcomes_v1|selection_reference_snapshots_v1)\s/
  const keyed = f.queries.filter(({ query }) => read.test(query) && !/GROUP BY/.test(query))
  assert.ok(keyed.length >= 9 * 2 * 2, String(keyed.length))
  const plan = (query: string, values: any[]) => (f.sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values) as any[]).map(row => String(row.detail))
  for (const { query, values } of keyed) {
    const detail = plan(query, values), table = query.match(read)![1]
    assert.ok(detail.every(line => !line.startsWith('SCAN') && !line.includes('MULTI-INDEX OR')), `${table}: ${detail.join(' | ')}`)
    // The index search is pinned to the key: its date (or, for labels_v2, the key's outcome_known_date band).
    assert.ok(detail.some(line => table === 'price_horizon_labels_v2'
      ? line.includes('idx_price_horizon_labels_v2_known (horizon_days=? AND outcome_known_date>? AND outcome_known_date<?)')
      : /SEARCH .*\((\w+=\? AND )*(price_date|signal_date)=\?/.test(line)), `${table}: ${detail.join(' | ')}`)
  }
  // The window counts of single tables are index range reads too (never the whole retained table).
  const counts = f.queries.filter(({ query }) => /GROUP BY/.test(query) && /^\s*SELECT [\w,]+,COUNT\(\*\) AS n FROM price_horizon_label\w*_v[12] /.test(query))
  assert.equal(counts.length, 4)
  for (const { query, values } of counts) {
    const detail = plan(query, values)
    assert.ok(detail.every(line => !line.startsWith('SCAN')) && detail.some(line => line.startsWith('SEARCH')), `${query.match(read)?.[1]}: ${detail.join(' | ')}`)
  }
  // Counter: the r1 OR chain over (date, horizon) pairs walks the horizon index once per pair (MULTI-INDEX OR).
  const pairs = processedDates.flatMap(date => [3, 5, 10].map(h => [date, h]))
  const orChain = plan(`SELECT stock_id FROM price_horizon_labels_v2 WHERE (${pairs.map(() => '(price_date=? AND horizon_days=?)').join(' OR ')})
    ORDER BY stock_id,price_date,horizon_days LIMIT 512`, pairs.flat())
  assert.ok(orChain.some(line => line.includes('MULTI-INDEX OR')), orChain.join(' | '))
  f.sql.close()
})

test('v2 projection: rejections are row-proven in scope and reconciled against rejected_count everywhere', async () => {
  const f = fixture()
  // One terminal rejection per date and horizon (stock 900), its status counting it.
  for (const signal of signals) {
    f.sql.prepare(`INSERT INTO price_horizon_label_rejections_v1(stock_id,price_date,entry_date,exit_date,rejection_reason,source,projection_version)
      VALUES(900,?,?,?,'exit_price_row_missing',?,?)`).run(signal, shift(signal, 1), shift(signal, 2), source, v1)
    f.sql.prepare(`UPDATE price_horizon_projection_status SET candidate_count=candidate_count+1,rejected_count=1 WHERE signal_date=?`).run(signal)
    for (const horizon of [3, 5, 10]) {
      f.sql.prepare(`INSERT INTO price_horizon_label_rejections_v2(stock_id,price_date,horizon_days,entry_date,exit_date,rejection_reason,source,projection_version)
        VALUES(900,?,?,?,?,'exit_price_row_missing',?,?)`).run(signal, horizon, shift(signal, 1), shift(signal, 2), source, v2)
      f.sql.prepare(`UPDATE price_horizon_projection_status_v2 SET candidate_count=candidate_count+1,rejected_count=1 WHERE signal_date=? AND horizon_days=?`).run(signal, horizon)
    }
  }
  const input = structuredClone(f.projection)
  Object.assign(input.producerResult.multiHorizon, { candidateCount: 9 * (STOCKS + 1), rejectedCount: 9 })
  const proof = await capturePostVerifyLabelEvidence(f.env, input)
  assert.equal(f.reads.get('rows:price_horizon_label_rejections_v2'), 9)
  assert.equal(f.reads.get('rows:price_horizon_label_rejections_v1') ?? 0, 0)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, JSON.parse(JSON.stringify(proof))), true)
  // An unprocessed date's rejection gone: rejected_count no longer matches (v1 and v2).
  const g = structuredClone(input)
  f.sql.exec(`DELETE FROM price_horizon_label_rejections_v1 WHERE price_date='${signals[1]}'`)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, g), new RegExp(`label_count_mismatch:1:${signals[1]}:5`))
  f.sql.exec(`UPDATE price_horizon_projection_status SET candidate_count=candidate_count-1,rejected_count=0 WHERE signal_date='${signals[1]}'`)
  f.sql.exec(`DELETE FROM price_horizon_label_rejections_v2 WHERE price_date='${signals[2]}' AND horizon_days=10`)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, g), new RegExp(`label_count_mismatch:2:${signals[2]}:10`))
  f.sql.exec(`UPDATE price_horizon_projection_status_v2 SET candidate_count=candidate_count-1,rejected_count=0 WHERE signal_date='${signals[2]}' AND horizon_days=10`)
  assert.equal((await capturePostVerifyLabelEvidence(f.env, g)).schema, 'post-verify-label-evidence-v2')
  // A processed key's rejection with an exit after the business date is invalid content.
  f.sql.exec(`UPDATE price_horizon_label_rejections_v2 SET exit_date='${shift(businessDate, 1)}' WHERE price_date='${processedDates[0]}' AND horizon_days=3`)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, g), /rejection_invalid/)
  f.sql.exec(`UPDATE price_horizon_label_rejections_v2 SET exit_date='${shift(processedDates[0], 2)}' WHERE price_date='${processedDates[0]}' AND horizon_days=3`)
  // A scope key's rejection count moving with its status but not in its row read: concurrent change.
  f.hook((query, rows) => /GROUP BY/.test(query) && /FROM price_horizon_label_rejections_v2/.test(query)
    ? rows.map(row => row.price_date === processedDates[1] && row.horizon_days === 5 ? { ...row, n: row.n + 1 } : row)
    : /FROM price_horizon_projection_status_v2/.test(query) && !/COUNT/.test(query)
      ? rows.map(row => row.signal_date === processedDates[1] && row.horizon_days === 5
        ? { ...row, candidate_count: row.candidate_count + 1, rejected_count: row.rejected_count + 1 } : row) : rows)
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, g), new RegExp(`concurrent_change:2:${processedDates[1]}:5`))
  f.sql.close()
})

test('v2 evidence stays far below the 32 KB receipt cap with every date of the window in row scope', async () => {
  // 114 signal dates = every calendar day of the 120-day window; all status rows written tonight, so the
  // row scope is 114 v1 keys and 342 multi-horizon keys (no producer night comes close).
  const f = fixture({ dates: 114, allTonight: true })
  const projection = structuredClone(f.projection), outcomes = structuredClone(f.outcomeInput)
  for (const proof of [await capturePostVerifyLabelEvidence(f.env, projection), await capturePostVerifyLabelEvidence(f.env, outcomes)]) {
    const bytes = new TextEncoder().encode(JSON.stringify(proof)).length
    // 24 KB leaves 8 KB of the receipt cap for its identity, the task summary and checksums.
    assert.ok(bytes < 24_576, `evidence bytes=${bytes}`)
    assert.equal(proof.tables.filter((table: any) => table.table === 'price_horizon_labels_v2' && table.kind !== 'group-count').length, 1)
  }
  assert.equal(rowsRead(f.reads, ['price_horizon_labels_v2']), 2 * 114 * 3 * STOCKS)
  f.sql.close()
})

test('v1 receipts are superseded; projection keys are required; outcomes need one learning binding', async () => {
  const f = fixture()
  const proof = await capturePostVerifyLabelEvidence(f.env, f.outcomeInput)
  const { checksum: _checksum, ...body } = { ...proof, schema: 'post-verify-label-evidence-v1', algorithm: 'sha256-page-chain-v1' }
  const legacy = { ...body, checksum: await (async () => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  })() }
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, legacy), false)
  assert.equal(await verifyPostVerifyLabelEvidence(f.env, proof), true)
  const missing = structuredClone(f.projection) as any
  delete missing.producerResult.multiHorizon.processedHorizonKeys
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, missing), /processed_keys_missing/)
  // A processed key without a status row is not a write this capture can reconcile.
  const orphan = structuredClone(f.projection) as any
  orphan.producerResult.multiHorizon.processedHorizonKeys[0] = { signalDate: shift(signals[0], -1), horizonDays: 3 }
  await assert.rejects(capturePostVerifyLabelEvidence(f.env, orphan), /processed_status_missing/)
  // References/labels/outcomes split across databases cannot be joined: fail closed (a read problem, thrown).
  const split = { ...f.env, LEARNING_DB: { prepare: f.env.DB.prepare } }
  await assert.rejects(capturePostVerifyLabelEvidence(split, f.outcomeInput), /split_learning_binding/)
  await assert.rejects(verifyPostVerifyLabelEvidence(split, proof), /split_learning_binding/)
  f.sql.close()
})
