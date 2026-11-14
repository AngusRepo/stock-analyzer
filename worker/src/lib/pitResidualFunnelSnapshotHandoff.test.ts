import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { Miniflare } from 'miniflare'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import { logChainedTask } from './postMarketChain'
import {
  enrichPitResidualFunnelForChain,
  recoverMissingPitResidualFunnels,
  runPitResidualFunnelEnrichmentAfterSnapshot,
  settleStalePitResidualWaits,
} from './pitResidualFunnelEnrichment'

// Real ops/learning DDL from the domain schemas; only rows are fixture inputs.
// No production I/O, decision, sizing or order authority is involved.
const OPS_SCHEMA = fs.readFileSync('domain-schemas/ops.sql', 'utf8')
const LEARNING_SCHEMA = fs.readFileSync('domain-schemas/learning.sql', 'utf8')
const BASE_STAGE = 'pit_residual_momentum_shadow_base'
const RESIDUAL_STAGE = 'pit_residual_momentum_shadow'
const TOKEN = 'isolated-g11-token'

function ddl(schema: string, table: string): string[] {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)
  assert(start >= 0, `missing DDL for ${table}`)
  const statements = [schema.slice(start, schema.indexOf(';', start))]
  const indexes = new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \\w+\\s+ON ${table}\\s*\\([^;]*`, 'g')
  for (const match of schema.matchAll(indexes)) statements.push(match[0])
  return statements
}

function utcSql(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ')
}

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("isolated") } }',
    d1Databases: ['OPS', 'LEARNING'],
    kvNamespaces: ['KV'],
  })
  try {
    await run(await setup(mf))
  } finally {
    await mf.dispose()
  }
}

async function setup(mf: Miniflare) {
  const ops = await mf.getD1Database('OPS')
  const learning = await mf.getD1Database('LEARNING')
  const kv = await mf.getKVNamespace('KV') as unknown as KVNamespace
  for (const table of [
    'screener_funnel_runs', 'screener_funnel_items', 'canonical_run_heads',
    'pit_residual_funnel_enrichment_runs_v1', 'pipeline_stage_runs', 'scheduler_execution_tickets_v1',
  ]) {
    for (const sql of ddl(OPS_SCHEMA, table)) await ops.prepare(sql).run()
  }
  for (const table of ['pit_factor_shadow_daily_v1', 'dataset_snapshots']) {
    for (const sql of ddl(LEARNING_SCHEMA, table)) await learning.prepare(sql).run()
  }
  const queued: unknown[] = []
  const env = {
    DB: ops, OPS_DB: ops, LEARNING_DB: learning, KV: kv,
    MULTI_D1_ACTIVE_DOMAINS: 'ops,learning', MULTI_D1_STRICT: 'true',
    STOCKVISION_AUTH_TOKEN: TOKEN,
    UPDATE_QUEUE: { send: async (message: unknown) => { queued.push(message) } },
  } as any
  const canonical = (day: string) => `pipeline:${day}:canonical`
  const screenerRun = (day: string) => `screener:${day}:run`

  async function seedDate(day: string, options: { shadow?: boolean; queuedMsAgo?: number; authority?: boolean } = {}) {
    await ops.prepare(`INSERT INTO screener_funnel_runs (run_id, date, status, candidate_count, final_count)
      VALUES (?, ?, 'success', 830, 683)`).bind(screenerRun(day), day).run()
    await ops.prepare(`INSERT INTO canonical_run_heads (logical_run_key, run_id, promoted_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)`)
      .bind(`screener:${day}:TW:production:market_screener`, screenerRun(day)).run()
    for (const [symbol, score, rank] of [['2330', 77.5, 1], ['2317', 60, 2]] as const) {
      await ops.prepare(`INSERT INTO screener_funnel_items
        (run_id, date, symbol, name, stage, decision, reason_code, score_before, score_after, rank)
        VALUES (?, ?, ?, NULL, ?, 'observe', 'fixture_base', ?, ?, ?)`)
        .bind(screenerRun(day), day, symbol, BASE_STAGE, score, score, rank).run()
    }
    if (options.authority !== false) {
      await ops.prepare(`INSERT INTO pipeline_stage_runs (business_date, stage, canonical_run_id, status)
        VALUES (?, 'pipeline_execution', ?, 'success')`).bind(day, canonical(day)).run()
    }
    await ops.prepare(`INSERT INTO pipeline_stage_runs (business_date, stage, canonical_run_id, status, queued_at)
      VALUES (?, 'post_pipeline_chain', ?, 'running', ?)`)
      .bind(day, canonical(day), utcSql(options.queuedMsAgo ?? 60_000)).run()
    if (options.shadow) await landShadow(day)
  }

  async function landShadow(day: string) {
    await learning.prepare(`INSERT INTO pit_factor_shadow_daily_v1 (
        signal_date, symbol, industry, taxonomy_snapshot_date, taxonomy_checksum,
        residual_momentum_rank, breadth_rank, flow_diffusion_rank,
        research_base_score, research_shadow_score, factor_contract_version)
      VALUES (?, '2330', '半導體', ?, 'taxonomy-checksum', 0.8, 0.7, 0.6, 0.4, 0.44, 'pit-factor-shadow-v1')`)
      .bind(day, day).run()
  }

  const receipt = (day: string) => ops.prepare(`SELECT status, last_error, pipeline_canonical_run_id
      FROM pit_residual_funnel_enrichment_runs_v1 WHERE business_date=?`).bind(day)
    .first<{ status: string; last_error: string | null; pipeline_canonical_run_id: string }>()
  const residualIds = async (day: string) => ((await ops.prepare(`SELECT id FROM screener_funnel_items
      WHERE run_id=? AND stage=? ORDER BY id`).bind(screenerRun(day), RESIDUAL_STAGE).all<{ id: number }>())
    .results ?? []).map((row) => row.id)
  const enrichmentLog = (day: string) => kv.get(`scheduler:run:pit-residual-funnel-enrichment:${day}`, 'json') as
    Promise<{ status: string; summary: string; run_id?: string } | null>

  async function postSnapshotCallback(day: string, status: 'success' | 'error') {
    const pending: Promise<unknown>[] = []
    const response = await adminControlRoutes.request('https://local.test/api/admin/cron-callback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'dataset-snapshot-export', status, run_date: day, run_id: `${canonical(day)}:postclose`,
        summary: status === 'success'
          ? `run_id=${canonical(day)}:postclose backtest=snap-${day} rows=1 price=price-${day} rows=1`
          : `run_id=${canonical(day)}:postclose RuntimeError: export failed`,
        ...(status === 'error' ? { error: 'RuntimeError: export failed' } : {}),
        duration_ms: 1,
      }),
    }, env, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) }, passThroughOnException() {}, props: {} } as any)
    const body = await response.json()
    await Promise.all(pending)
    return { status: response.status, body, waitUntilCount: pending.length }
  }

  async function readySnapshot(day: string) {
    await learning.prepare(`INSERT INTO dataset_snapshots (snapshot_id, kind, business_date, schema_version,
        checksum, primary_store, access_tier, producer_run_id, status)
      VALUES (?, 'backtest_dataset', ?, 'v1', 'c', 'gcs', 'compute', 'fixture', 'ready')`)
      .bind(`snap-${day}`, day).run()
  }

  return {
    ops, learning, kv, env, queued, canonical, screenerRun, seedDate, landShadow, receipt,
    residualIds, enrichmentLog, postSnapshotCallback, readySnapshot,
  }
}

test('snapshot success callback enriches once; a duplicate callback does not rewrite', async () => fixture(async (f) => {
  const day = '2026-11-11'
  await f.seedDate(day, { shadow: true })
  await f.readySnapshot(day)

  const first = await f.postSnapshotCallback(day, 'success')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.deepEqual(first.body, { ok: true, task: 'dataset-snapshot-export', status: 'success' })
  assert.equal(f.queued.length, 1, 'active8 snapshot continuation still queues')
  assert.equal((await f.kv.get(`scheduler:run:dataset-snapshot-export:${day}`, 'json') as any)?.status, 'success')
  const receipt = await f.receipt(day)
  assert.equal(receipt?.status, 'success')
  assert.equal(receipt?.pipeline_canonical_run_id, f.canonical(day))
  const ids = await f.residualIds(day)
  assert.equal(ids.length, 2)
  const log = await f.enrichmentLog(day)
  assert.equal(log?.status, 'success')
  assert.equal(log?.run_id, f.canonical(day))
  assert.match(String(log?.summary), /trigger=dataset_snapshot_callback/)

  const duplicate = await f.postSnapshotCallback(day, 'success')
  assert.equal(duplicate.status, 200)
  assert.deepEqual(await f.residualIds(day), ids, 'duplicate callback must not delete and reinsert residual rows')
  assert.match(String((await f.enrichmentLog(day))?.summary), /pit_residual_funnel_already_enriched/)
  const recovery = await recoverMissingPitResidualFunnels(f.env, { throughDate: day, maxDates: 3 })
  assert.deepEqual(recovery.attemptedDates, [], 'a success receipt is settled for recovery as well')
}))

test('enrichment failure never changes the callback response', async () => fixture(async (f) => {
  const day = '2026-11-11'
  await f.seedDate(day, { shadow: false })
  await f.readySnapshot(day)
  const result = await f.postSnapshotCallback(day, 'success')
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body, { ok: true, task: 'dataset-snapshot-export', status: 'success' })
  assert.equal((await f.receipt(day))?.status, 'error')
  assert.match(String((await f.receipt(day))?.last_error), /^pit_residual_same_day_snapshot_missing:/)
  assert.equal((await f.enrichmentLog(day))?.status, 'error', 'failure is recorded on the enrichment task')

  // An error callback is passed through unchanged; the shadow written before the export still counts.
  await f.landShadow(day)
  const failedExport = await f.postSnapshotCallback(day, 'error')
  assert.equal(failedExport.status, 200)
  assert.deepEqual(failedExport.body, { ok: true, task: 'dataset-snapshot-export', status: 'error' })
  assert.equal((await f.receipt(day))?.status, 'success')

  // A date without a successful pipeline_execution is not owned by anyone: skip, no log.
  const orphan = '2026-11-06'
  await f.seedDate(orphan, { shadow: true, authority: false })
  assert.match(await runPitResidualFunnelEnrichmentAfterSnapshot(f.env, { businessDate: orphan }), /^skipped: no successful pipeline_execution/)
  assert.equal(await f.enrichmentLog(orphan), null)
  assert.equal(await f.receipt(orphan), null)

  // Unexpected storage failures stay inside the hand-off.
  await f.ops.prepare('DROP TABLE pit_residual_funnel_enrichment_runs_v1').run()
  const broken = await f.postSnapshotCallback(day, 'success')
  assert.equal(broken.status, 200)
  assert.equal(broken.waitUntilCount >= 1, true)
}))

test('14:20 step waits only while this run\'s snapshot is in flight', async () => fixture(async (f) => {
  const step = async (day: string) => logChainedTask(f.env, { runDate: day, upstreamRunId: f.canonical(day) },
    'pit-residual-funnel-enrichment', () => enrichPitResidualFunnelForChain(f.env, {
      businessDate: day, pipelineCanonicalRunId: f.canonical(day),
    }), { critical: false })

  const inFlight = '2026-11-11'
  await f.seedDate(inFlight, { queuedMsAgo: 2 * 60_000 })
  const waiting = await step(inFlight)
  assert.equal(waiting.status, 'waiting', waiting.summary)
  assert.match(waiting.summary, /pit_residual_same_day_snapshot_missing:2026-11-11/)
  assert.equal((await f.enrichmentLog(inFlight))?.status, 'waiting')
  // The snapshot callback then settles the same run's log to success.
  await f.landShadow(inFlight)
  await runPitResidualFunnelEnrichmentAfterSnapshot(f.env, { businessDate: inFlight })
  assert.equal((await f.enrichmentLog(inFlight))?.status, 'success')
  const rerun = await step(inFlight)
  assert.match(rerun.summary, /pit_residual_funnel_already_enriched/)

  const callbackDone = '2026-11-10'
  await f.seedDate(callbackDone, { queuedMsAgo: 2 * 60_000 })
  await f.kv.put(`scheduler:run:dataset-snapshot-export:${callbackDone}`, JSON.stringify({
    task: 'dataset-snapshot-export', status: 'success', run_id: `${f.canonical(callbackDone)}:postclose`,
    run_date: callbackDone, summary: 'done', duration_ms: 1, timestamp: new Date().toISOString(),
  }))
  assert.equal((await step(callbackDone)).status, 'error', 'snapshot finished but shadow missing is an error')

  const stale = '2026-11-07'
  await f.seedDate(stale, { queuedMsAgo: 3 * 3600_000 })
  assert.equal((await step(stale)).status, 'error', 'missing well after the snapshot window is an error')

  const otherRunSnapshot = '2026-11-05'
  await f.seedDate(otherRunSnapshot, { queuedMsAgo: 2 * 60_000 })
  await f.kv.put(`scheduler:run:dataset-snapshot-export:${otherRunSnapshot}`, JSON.stringify({
    task: 'dataset-snapshot-export', status: 'error', run_id: 'pipeline:older:canonical:postclose',
    run_date: otherRunSnapshot, summary: 'old', duration_ms: 1, timestamp: new Date().toISOString(),
  }))
  assert.equal((await step(otherRunSnapshot)).status, 'waiting', 'another run\'s callback does not settle this run')

  const otherFailure = '2026-11-04'
  await f.seedDate(otherFailure, { queuedMsAgo: 2 * 60_000 })
  await f.ops.prepare('DELETE FROM canonical_run_heads WHERE logical_run_key=?')
    .bind(`screener:${otherFailure}:TW:production:market_screener`).run()
  const missingRun = await step(otherFailure)
  assert.equal(missingRun.status, 'error')
  assert.match(missingRun.summary, /^pit_residual_canonical_screener_run_missing:/)
}))

test('recovery drains up to three backlog dates per run', async () => fixture(async (f) => {
  for (const day of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-10']) {
    await f.seedDate(day, { shadow: true })
  }
  const first = await recoverMissingPitResidualFunnels(f.env, {
    throughDate: '2026-11-10', excludeBusinessDate: '2026-11-10', maxDates: 3,
  })
  assert.deepEqual(first.attemptedDates, ['2026-11-06', '2026-11-05', '2026-11-04'])
  assert.equal(first.recovered.length, 3)
  assert.equal(first.failures.length, 0)
  const second = await recoverMissingPitResidualFunnels(f.env, {
    throughDate: '2026-11-10', excludeBusinessDate: '2026-11-10', maxDates: 3,
  })
  assert.deepEqual(second.attemptedDates, ['2026-11-03'])
  assert.equal(await f.receipt('2026-11-10'), null, 'the current date stays with its own chain step')

  const chain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
  const recoveryStep = chain.slice(chain.indexOf("'pit-residual-funnel-recovery'"))
  assert.match(recoveryStep.slice(0, 1200), /maxDates: 3 \}/)
  assert.match(recoveryStep.slice(0, 1200), /settleStalePitResidualWaits\(env, \{ ...window, recovery: result \}\)/)
}))

test('next-day recovery settles stale 14:20 waits; fresh waits stay', async () => fixture(async (f) => {
  const waitingEntry = (day: string, msAgo: number) => f.kv.put(
    `scheduler:run:pit-residual-funnel-enrichment:${day}`,
    JSON.stringify({
      task: 'pit-residual-funnel-enrichment', status: 'waiting', run_id: f.canonical(day),
      attempt_id: `${f.canonical(day)}:attempt-0`, run_date: day, duration_ms: 1,
      summary: `status=waiting pit_residual_same_day_snapshot_pending date=${day}`,
      timestamp: new Date(Date.now() - msAgo).toISOString(),
    }),
  )
  const today = '2026-11-12'
  const neverCompleted = '2026-11-11'
  const completedByRecovery = '2026-11-10'
  const notCandidate = '2026-11-06'
  const fresh = '2026-11-09'
  await f.seedDate(today, { shadow: true })
  await f.seedDate(neverCompleted, { shadow: false })
  await f.seedDate(completedByRecovery, { shadow: true })
  await f.seedDate(notCandidate, { shadow: true, authority: false })
  await f.seedDate(fresh, { shadow: false })
  for (const day of [neverCompleted, completedByRecovery, notCandidate]) await waitingEntry(day, 20 * 3600_000)
  await waitingEntry(fresh, 10 * 60_000)

  const window = { throughDate: today, excludeBusinessDate: today }
  const recovery = await recoverMissingPitResidualFunnels(f.env, { ...window, maxDates: 3 })
  assert.deepEqual(recovery.attemptedDates, [completedByRecovery])
  const settled = await settleStalePitResidualWaits(f.env, { ...window, recovery })
  assert.match(settled, /^stale_waiting_settled=/)

  const never = await f.enrichmentLog(neverCompleted)
  assert.equal(never?.status, 'error')
  assert.match(String(never?.summary), /^pit_residual_snapshot_never_completed:2026-11-11/)
  const done = await f.enrichmentLog(completedByRecovery)
  assert.equal(done?.status, 'success')
  assert.equal(done?.run_id, f.canonical(completedByRecovery))
  const ineligible = await f.enrichmentLog(notCandidate)
  assert.equal(ineligible?.status, 'error', 'a date recovery never picks must not stay waiting')
  assert.match(String(ineligible?.summary), /^pit_residual_funnel_not_recovered:2026-11-06/)
  assert.equal((await f.enrichmentLog(fresh))?.status, 'waiting', 'a wait inside the snapshot window is untouched')
  assert.equal(await f.enrichmentLog(today), null, 'the current date stays with its own chain step')

  // A success receipt written outside recovery also settles a stale wait.
  const receiptOnly = '2026-11-05'
  await f.seedDate(receiptOnly, { shadow: true })
  await runPitResidualFunnelEnrichmentAfterSnapshot(f.env, { businessDate: receiptOnly })
  await waitingEntry(receiptOnly, 20 * 3600_000)
  await settleStalePitResidualWaits(f.env, { ...window, recovery: null })
  assert.equal((await f.enrichmentLog(receiptOnly))?.status, 'success')
}))

test('a callback error for the run is not masked by a later 14:20 wait', async () => fixture(async (f) => {
  const day = '2026-11-11'
  await f.seedDate(day, { queuedMsAgo: 2 * 60_000 })
  assert.match(await runPitResidualFunnelEnrichmentAfterSnapshot(f.env, { businessDate: day }), /^error: pit_residual_same_day_snapshot_missing/)
  assert.equal((await f.enrichmentLog(day))?.status, 'error')
  const step = await logChainedTask(f.env, { runDate: day, upstreamRunId: f.canonical(day) },
    'pit-residual-funnel-enrichment', () => enrichPitResidualFunnelForChain(f.env, {
      businessDate: day, pipelineCanonicalRunId: f.canonical(day),
    }), { critical: false })
  assert.equal(step.status, 'error')
  assert.equal((await f.enrichmentLog(day))?.status, 'error')
}))
