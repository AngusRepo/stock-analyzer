// L-2: Learning predictions 127-day hot window (120-day reader floor + 7 buffer days), executed end to end on SQLite with the real
// learning/ops schemas: archive to R2, read-back checksum, exact-row delete, source receipt.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  RETENTION_HOT_READER_FLOORS,
  RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE,
  retentionHotDrainCutoff,
  runRetentionHotWindowDrain,
  summarizeRetentionHotWindowDrain,
} from './retentionHotWindowDrain'
import { sha256Text } from './datasetSnapshots'
import type { Bindings } from '../types'

const BUSINESS_DATE = '2026-12-02'
const CUTOFF = '2026-07-28' // BUSINESS_DATE - 127 days (120-day reader floor + 7 buffer days)
// The predictions floor never counts from a future business date, so "today" is BUSINESS_DATE.
// The clock still advances 1 ms per read: drain run ids carry Date.now().
const clockBase = Date.parse(`${BUSINESS_DATE}T04:00:00.000Z`)
let clockTicks = 0
Date.now = () => clockBase + clockTicks++

function fixture(options: { tamperReadback?: boolean; hotDays?: number } = {}) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync('domain-schemas/learning.sql', 'utf8'))
  sql.exec(readFileSync('domain-schemas/ops.sql', 'utf8'))
  sql.prepare(`UPDATE data_retention_policies SET hot_retention_days=?, cold_retention_days=3650,
    archive_store='r2', action='archive_delete', hard_reference_protected=1, status='active'
    WHERE policy_id='learning_lineage_v1'`).run(options.hotDays ?? 120)
  const queries: Array<{ query: string; params: unknown[] }> = []
  function prepare(query: string, params: unknown[] = []) {
    return {
      query, params,
      bind(...values: unknown[]) { return prepare(query, values) },
      async first() { queries.push({ query, params }); return sql.prepare(query).get(...params as any[]) ?? null },
      async all() { queries.push({ query, params }); return { results: sql.prepare(query).all(...params as any[]) } },
      async run() {
        queries.push({ query, params })
        return { success: true, meta: { changes: Number(sql.prepare(query).run(...params as any[]).changes) } }
      },
    }
  }
  const db = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sql.exec('BEGIN')
    try {
      const results = statements.map((statement) => {
        queries.push({ query: statement.query, params: statement.params })
        const q = sql.prepare(statement.query)
        return { results: q.columns().length ? q.all(...statement.params as any[]) : (q.run(...statement.params as any[]), []) }
      })
      sql.exec('COMMIT')
      return results
    } catch (error) { if (sql.isTransaction) sql.exec('ROLLBACK'); throw error }
  } }
  const objects = new Map<string, string>()
  const artifacts = {
    async put(key: string, body: string, opts?: { onlyIf?: { etagDoesNotMatch?: string } }) {
      if (opts?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) throw new Error('precondition_failed')
      objects.set(key, body)
    },
    async get(key: string) {
      const raw = objects.get(key)
      if (raw === undefined) return null
      const body = options.tamperReadback ? raw.replace('"forecast_data":"', '"forecast_data":"X') : raw
      return { size: Buffer.byteLength(body), text: async () => body }
    },
  }
  const env = { DB: db, ARTIFACTS: artifacts } as unknown as Bindings
  let id = 1000
  function insert(date: string, model: string, forecast = 'f'.repeat(64)) {
    sql.prepare(`INSERT INTO predictions(id, stock_id, model_name, generated_at, prediction_date, forecast_data,
      trade_signal, verified_at, created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(++id, 2330 + (id % 7), model, `${date} 13:30:00`, date, forecast, 'hold', null, `${date} 13:30:00`)
  }
  for (const model of ['ensemble', 'LightGBM', 'XGBoost']) insert('2026-04-30', model, 'e'.repeat(model === 'ensemble' ? 20_000 : 80))
  for (const model of ['ensemble', 'LightGBM']) insert('2026-05-04', model)
  insert('2026-07-27', 'ensemble')
  for (const model of ['ensemble', 'LightGBM']) insert(CUTOFF, model) // first day every 120-day reader needs
  insert('2026-09-01', 'ensemble')
  insert('2026-11-30', 'ensemble')
  const dates = () => (sql.prepare('SELECT prediction_date d, COUNT(*) n FROM predictions GROUP BY d ORDER BY d').all() as any[])
    .map((row) => `${row.d}:${row.n}`)
  const count = (table: string) => Number((sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n)
  return { sql, env, objects, queries, dates, count }
}

const confirmed = { policyIds: ['learning_lineage_v1'] as const, businessDate: BUSINESS_DATE,
  confirmPhrase: RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE, maxRounds: 10 }

test('cutoff keeps every scheduled 120-day predictions reader whole, even if the policy row is shortened', () => {
  assert.equal(retentionHotDrainCutoff(BUSINESS_DATE, 120, 'predictions'), CUTOFF)
  assert.equal(retentionHotDrainCutoff(BUSINESS_DATE, 60, 'predictions'), CUTOFF)
  assert.equal(retentionHotDrainCutoff(BUSINESS_DATE, 180, 'predictions'), '2026-06-05')
  assert.equal(retentionHotDrainCutoff(BUSINESS_DATE, 60, 'market_trading_sessions'), '2026-10-03')
  // A future business date cannot move the predictions cutoff past Taipei today - 127 days.
  assert.equal(retentionHotDrainCutoff('2027-03-01', 120, 'predictions', BUSINESS_DATE), CUTOFF)
  assert.equal(retentionHotDrainCutoff('2027-03-01', 60, 'market_trading_sessions', BUSINESS_DATE), '2026-12-31')
  // Each floor reader still reads at most 120 days from D1 (7 more buffer days stay hot); a longer window needs a new floor or a cold reader.
  const floor = RETENTION_HOT_READER_FLOORS.predictions.days
  const opb = readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
  const opbBody = opb.slice(opb.indexOf("controllerFetch(env, '/opb_arm_prior/refresh'"))
  assert.equal(Number(/lookback_days: (\d+)/.exec(opbBody)?.[1]), floor)
  assert.equal(Number(/const DEFAULT_LOOKBACK_DAYS = (\d+)/.exec(readFileSync('src/lib/priceHorizonProjection.ts', 'utf8'))?.[1]), floor)
  const s12 = readFileSync('../ml-controller/services/s12_trade_ev_bootstrap.py', 'utf8')
  assert.equal(Number(/S12_TRADE_EV_BOOTSTRAP_MAX_LOOKBACK_DAYS = (\d+)/.exec(s12)?.[1]), floor)
  // ml-controller short-circuits reads that start after the same floor.
  const reads = readFileSync('../ml-controller/services/retention_prediction_reads.py', 'utf8')
  assert.equal(Number(/PREDICTIONS_HOT_FLOOR_DAYS = (\d+)/.exec(reads)?.[1]), floor + RETENTION_HOT_READER_FLOORS.predictions.bufferDays)
  assert.equal(retentionHotDrainCutoff(BUSINESS_DATE, 127, 'predictions'), CUTOFF)
})

test('a full confirmed drain archives and deletes only rows older than the 127-day window', async () => {
  const f = fixture({ hotDays: 60 })
  const result = await runRetentionHotWindowDrain(f.env, confirmed)
  assert.equal(result.status, 'success')
  assert.equal(result.deleted_rows, 6)
  assert.deepEqual(f.dates(), [`${CUTOFF}:2`, '2026-09-01:1', '2026-11-30:1'])
  const predictions = result.policies[0].datasets.find((d) => d.dataset_id === 'predictions')!
  assert.equal(predictions.cutoff_date, CUTOFF)
  assert.equal(predictions.backlog_remaining, false)
  // Every deleted row sits in a verified R2 archive with a matching source receipt.
  const archived = [...f.objects.values()].map((raw) => JSON.parse(raw).payload)
  assert.deepEqual(archived.flatMap((payload) => payload.rows.map((row: any) => row.prediction_date)).sort(),
    ['2026-04-30', '2026-04-30', '2026-04-30', '2026-05-04', '2026-05-04', '2026-07-27'])
  for (const payload of archived) {
    assert.equal(payload.row_checksum, await sha256Text(JSON.stringify(payload.rows)))
    assert.ok(payload.rows.every((row: any) => row.prediction_date < CUTOFF))
  }
  assert.equal(Number((f.sql.prepare(`SELECT SUM(row_count) n FROM learning_retention_releases_v1
    WHERE dataset_id='predictions'`).get() as any).n), 6)
  const items = f.sql.prepare(`SELECT deleted_rows, evidence_json FROM data_retention_run_items
    WHERE dataset_id='hot-drain:predictions' AND status='success'`).all() as any[]
  assert.equal(items.reduce((sum, item) => sum + Number(item.deleted_rows), 0), 6)
  assert.ok(items.every((item) => JSON.parse(item.evidence_json).checksum_verified_at))
})

test('pilot drains only the oldest day and leaves the rest of the backlog visible', async () => {
  const f = fixture()
  const result = await runRetentionHotWindowDrain(f.env, { ...confirmed, pilotOneDay: true })
  assert.equal(result.status, 'success')
  assert.equal(result.pilot_one_day, true)
  assert.equal(result.deleted_rows, 3)
  assert.deepEqual(f.dates(), ['2026-05-04:2', '2026-07-27:1', `${CUTOFF}:2`, '2026-09-01:1', '2026-11-30:1'])
  const predictions = result.policies[0].datasets.find((d) => d.dataset_id === 'predictions')!
  assert.equal(predictions.cutoff_date, '2026-05-01')
  assert.equal(predictions.backlog_remaining, true)
  assert.equal(result.backlog_remaining, true)
  assert.match(summarizeRetentionHotWindowDrain(result), /dry_run=false pilot_one_day=true .* deleted=3 archived_bytes=[1-9]\d* backlog=true /)
  const evidence = (f.sql.prepare(`SELECT evidence_json FROM data_retention_run_items
    WHERE dataset_id='hot-drain:predictions' AND status='success'`).all() as any[]).map((row) => JSON.parse(row.evidence_json))
  assert.ok(evidence.length >= 1 && evidence.every((item) => item.pilot_one_day === true && item.floor_cutoff_date === CUTOFF))
  // The next pilot call takes the next day.
  const next = await runRetentionHotWindowDrain(f.env, { ...confirmed, pilotOneDay: true })
  assert.equal(next.deleted_rows, 2)
  assert.deepEqual(f.dates(), ['2026-07-27:1', `${CUTOFF}:2`, '2026-09-01:1', '2026-11-30:1'])
  await assert.rejects(runRetentionHotWindowDrain(f.env, { ...confirmed, policyIds: undefined, pilotOneDay: true }),
    /retention_hot_drain_pilot_requires_one_policy/)
})

test('a read-back checksum mismatch stops before any row is deleted', async () => {
  const f = fixture({ tamperReadback: true })
  const before = f.dates()
  const result = await runRetentionHotWindowDrain(f.env, confirmed)
  assert.equal(result.status, 'error')
  assert.equal(result.deleted_rows, 0)
  assert.match(String(result.policies[0].error), /predictions:artifact_r2_checksum_mismatch/)
  assert.deepEqual(f.dates(), before)
  assert.equal(f.count('learning_retention_releases_v1'), 0)
  assert.equal(f.count(`run_artifacts WHERE domain='retention_learning_lineage_v1_predictions'`), 0)
})

test('dry-run preflight neither archives nor deletes', async () => {
  const f = fixture()
  const result = await runRetentionHotWindowDrain(f.env, { ...confirmed, confirmPhrase: null })
  assert.equal(result.dry_run, true)
  assert.equal(result.policies[0].datasets.find((d) => d.dataset_id === 'predictions')?.candidates, 6)
  assert.equal(f.objects.size, 0)
  assert.equal(f.count('predictions'), 10)
})

test('every predictions statement of a drain uses an index or rowid, never a table scan', async () => {
  const f = fixture()
  await runRetentionHotWindowDrain(f.env, { ...confirmed, pilotOneDay: true })
  const statements = f.queries.filter(({ query }) => /\bpredictions\b/.test(query.replace(/learning_retention_releases_v1|retention_learning_lineage_v1_predictions|hot-drain:predictions|'predictions'/g, '')))
  const kinds = new Set<string>(statements.map(({ query }) => /INSERT INTO prediction_cold_stats_v1/.test(query) ? 'cold_stats'
    : /DELETE FROM/.test(query) ? 'delete'
    : /WITH candidates AS MATERIALIZED/.test(query) ? 'candidates' : /MIN\(/.test(query) ? 'pilot_min'
      : /__cursor_key IN/.test(query) ? 'recheck' : /SELECT 1 FROM/.test(query) ? 'probe' : 'other'))
  for (const kind of ['delete', 'candidates', 'pilot_min', 'recheck', 'probe', 'cold_stats']) assert.ok(kinds.has(kind), kind)
  for (const { query, params } of statements) {
    if (/pragma_table_info|sqlite_master/.test(query)) continue
    const plan = (f.sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params as any[]) as any[]).map((row) => String(row.detail))
    // `p` is the predictions alias of the cold-stats insert.
    assert.ok(plan.some((detail) => /^SEARCH ("?predictions"?|p) /.test(detail)), `${plan.join(' | ')}\n${query}`)
    assert.ok(!plan.some((detail) => /^SCAN ("?predictions"?|p)(\s|$)/.test(detail)), `${plan.join(' | ')}\n${query}`)
  }
})

test('after the backlog a confirmed pass writes one compact heartbeat a day, then nothing', async () => {
  const f = fixture({ hotDays: 60 })
  assert.equal((await runRetentionHotWindowDrain(f.env, confirmed)).deleted_rows, 6)
  const opsWrites = () => f.queries.filter(({ query }) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query)
    && /data_retention_(runs|run_items|cursors)/.test(query))
  const ledger = () => ['data_retention_runs', 'data_retention_run_items', 'data_retention_cursors'].map(f.count)
  // The same UTC day as the draining pass: every cursor is unchanged and fresh, so nothing is written.
  f.queries.length = 0
  const before = ledger()
  const quiet = await runRetentionHotWindowDrain(f.env, confirmed)
  assert.equal(quiet.status, 'success')
  assert.equal(quiet.archived_rows, 0)
  assert.deepEqual(opsWrites().map(({ query }) => query.trim().slice(0, 40)), [])
  assert.deepEqual(ledger(), before)
  // Next UTC day (cursor older than today): 5 row writes: run insert + finish, predictions item + cursor, one compact blocked item.
  f.sql.prepare("UPDATE data_retention_cursors SET updated_at=datetime('now','-1 day') WHERE policy_id='learning_lineage_v1'").run()
  f.queries.length = 0
  const runsBefore = f.count('data_retention_runs'), itemsBefore = f.count('data_retention_run_items')
  const heartbeat = await runRetentionHotWindowDrain(f.env, confirmed)
  assert.equal(heartbeat.status, 'success')
  assert.equal(f.count('data_retention_runs') - runsBefore, 1)
  const items = f.sql.prepare(`SELECT dataset_id, status, backlog_remaining FROM data_retention_run_items
    WHERE rowid > ? ORDER BY dataset_id`).all(itemsBefore) as any[]
  assert.deepEqual(items.map((item) => `${item.dataset_id}:${item.status}:${item.backlog_remaining}`),
    ['hot-drain:blocked-sources:skipped:1', 'hot-drain:predictions:skipped:0'])
  assert.ok(opsWrites().length <= 5, opsWrites().map(({ query }) => query.trim().slice(0, 40)).join(' | '))
  const cursor = f.sql.prepare(`SELECT status, backlog_remaining, date(updated_at)=date('now') fresh FROM data_retention_cursors
    WHERE policy_id='learning_lineage_v1' AND dataset_id='hot-drain:predictions'`).get() as any
  assert.deepEqual({ ...cursor }, { status: 'cycle_complete', backlog_remaining: 0, fresh: 1 })
  // Blocked sources keep their cursors (backlog visible to readiness and the storage closure).
  const blocked = f.sql.prepare(`SELECT COUNT(*) n FROM data_retention_cursors WHERE policy_id='learning_lineage_v1'
    AND dataset_id LIKE 'hot-drain:%' AND dataset_id <> 'hot-drain:predictions' AND status='running' AND backlog_remaining=1`).get() as any
  assert.equal(blocked.n, 10)
})

test('the predictions drain job is the only confirmed hot-window job; the all-policy preflight stays read-only', () => {
  const scheduler = JSON.parse(readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
  const drains = scheduler.jobs.filter((job: { task: string }) => job.task === 'retention-hot-window-drain')
  assert.deepEqual(drains.map((job: { id: string }) => job.id), ['retention-hot-window-drain', 'retention-hot-window-drain-predictions'])
  const job = drains[1]
  const query = new URLSearchParams(job.query)
  assert.equal(query.get('confirm_drain'), RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE)
  assert.equal(query.get('policies'), 'learning_lineage_v1')
  assert.equal(query.get('pilot'), null)
  assert.equal(job.desiredState, 'PAUSED') // enabled only after learning 0073, ops 0029 and the >= 20 MB pilot
  assert.ok(Number(query.get('budget_ms')) <= 120_000 && Number(query.get('max_rounds')) <= 10)
  assert.equal(job.attemptDeadline, '300s')
  assert.equal(job.timeZone ?? scheduler.timeZone, 'UTC')
  // TW 16:00-17:45, every 15 minutes (8 passes): after the post-close strategy-learning / dataset-snapshot /
  // Active-8 recovery writes (observed to end by ~14:57) and before the 18:10 market-close-refresh.
  assert.equal(job.schedule, '0,15,30,45 8-9 * * *')
  const twMinutes = (cron: string): number[] => {
    const [minutes, hours] = cron.split(' ')
    const expand = (field: string) => field.split(',').flatMap((part) => {
      const [lo, hi] = part.split('-').map(Number)
      return hi === undefined ? [lo] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
    })
    return expand(hours).flatMap((h) => expand(minutes).map((m) => (((h + 8) % 24) * 60 + m)))
  }
  const at = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
  const passes = twMinutes(job.schedule)
  assert.equal(passes.length, 8) // keeps the ~4-night backlog clearance rate
  const deadline = Number(job.attemptDeadline.replace('s', '')) / 60
  const forbidden = [['01:00', '07:00'], ['14:15', '15:40'], ['21:40', '23:30']].map(([a, b]) => [at(a), at(b)])
  for (const start of passes) {
    const end = start + deadline
    assert.ok(start >= at('15:45') && end <= at('18:05'), `pass at ${start} must stay in the 15:45-18:05 learning quiet window`)
    for (const [a, b] of forbidden) assert.ok(end <= a || start >= b, `pass at ${start} overlaps a LEARNING_DB no-touch window`)
  }
  // The adjacent learning/ops writers must stay outside that window; moving one of them must revisit the drain.
  const neighbours = ['postclose-research-dispatch', 'daily-execution-paper-lineage', 'market-close-refresh', 'daily-snapshot-settle', 'hmm-maintenance', 'optuna-queue', 'kv-config-drift']
  for (const id of neighbours) {
    const other = scheduler.jobs.find((candidate: { id: string }) => candidate.id === id)
    assert.ok(other && !other.timeZone, `${id} must remain a UTC job`)
    for (const start of twMinutes(other.schedule.replace('*/6', '0,6,12,18'))) {
      assert.ok(start < at('15:45') || start >= at('18:05'), `${id} at ${start} now falls inside the predictions drain window`)
    }
  }
})
