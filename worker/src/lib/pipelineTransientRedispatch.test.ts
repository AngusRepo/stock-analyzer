import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import type { Bindings } from '../types'
import {
  enqueuePostScreenerPipelineRecovery,
  PIPELINE_DISPATCH_LOST_ERROR,
  pipelineTransientRedispatchDecision,
  TRANSIENT_REDISPATCH_REASON,
} from './postScreenerContinuation'
import { alertPipelineRecovery } from './screenerRecoveryWatchdog'

const DATE = '2026-11-12'
const D1_OVERLOADED = 'RuntimeError: D1 request unsuccessful: [{"code":7429,"message":"D1 DB is overloaded. Requests queued for too long."}]'
const BEFORE_CUTOFF = Date.parse('2026-11-12T19:00:00Z') // 11/13 03:00 TW
const AFTER_CUTOFF = Date.parse('2026-11-12T21:45:00Z') // 11/13 05:45 TW

const failure = (lastError: string, status = 'error') => ({
  canonical_run_id: 'pipeline-dispatch:2026-11-12:failed', status, last_error: lastError, updated_at: '2026-11-12 16:30:00',
})

test('FG-05 redispatches only transient errors, before 05:45 TW', () => {
  for (const error of [
    D1_OVERLOADED,
    'RuntimeError: D1 request failed: HTTP 503: upstream',
    'RuntimeError: D1 raw request failed: network error: reset',
    'Error: D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.',
    PIPELINE_DISPATCH_LOST_ERROR,
  ]) {
    assert.deepEqual(pipelineTransientRedispatchDecision({ failure: failure(error), businessDate: DATE, nowMs: BEFORE_CUTOFF }),
      { retry: true, reason: TRANSIENT_REDISPATCH_REASON }, error)
  }
  for (const error of [
    'pipeline_stage_gpu_attempts_exhausted',
    'pipeline_modal_timexer_cardinality_mismatch',
    'pipeline_cloud_run_failed:memory_limit;completed_at=2026-11-12T16:00:00Z;execution=pipeline-v2-abc',
    'RuntimeError: D1 request failed: HTTP 401: auth',
    'HMM_DECISION_LINEAGE_UNVERIFIED',
    // A D1 message that is not the whole error: joined critical errors or a wrapped GPU failure.
    'pipeline_stage_gpu_attempts_exhausted; l2_write: RuntimeError: D1 request failed: HTTP 503: x',
    'pipeline_modal_timexer_cardinality_mismatch; RuntimeError: D1 request failed: network error: reset',
    'RuntimeError: pipeline_stage_gpu_failed:RuntimeError: D1 request failed: HTTP 503',
    'HMM_DECISION_LINEAGE_UNVERIFIED: D1 raw request failed: HTTP 429',
    'ValueError: active8_ensemble_base_identity_mismatch_x D1_ERROR: D1 DB is overloaded',
    'RuntimeError: D1 request failed: HTTP 503: x; pipeline_modal_timexer_cardinality_mismatch',
  ]) {
    assert.equal(pipelineTransientRedispatchDecision({ failure: failure(error), businessDate: DATE, nowMs: BEFORE_CUTOFF }), null, error)
  }
  assert.equal(pipelineTransientRedispatchDecision({ failure: failure(D1_OVERLOADED, 'running'), businessDate: DATE, nowMs: BEFORE_CUTOFF }), null)
  assert.deepEqual(pipelineTransientRedispatchDecision({ failure: failure(D1_OVERLOADED), businessDate: DATE, nowMs: AFTER_CUTOFF }),
    { retry: false, reason: 'transient_redispatch_window_closed' })
})

async function withOps(run: (db: D1Database, env: Bindings, sent: unknown[]) => Promise<void>, extra: Record<string, unknown> = {}) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['OPS'] })
  try {
    const db = await mf.getD1Database('OPS')
    await db.prepare(`CREATE TABLE pipeline_stage_runs (
      business_date TEXT NOT NULL, stage TEXT NOT NULL, canonical_run_id TEXT NOT NULL,
      status TEXT NOT NULL, cursor_key TEXT, processed_count INTEGER NOT NULL DEFAULT 0,
      expected_count INTEGER, persisted_count INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT,
      queued_at TEXT, started_at TEXT, completed_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (business_date, stage))`).run()
    await db.prepare(`CREATE TABLE system_logs (id INTEGER PRIMARY KEY, level TEXT, cron_name TEXT, message TEXT, meta TEXT, created_at TEXT)`).run()
    const sent: unknown[] = []
    const kv = new Map<string, string>()
    const env = {
      DB: db, OPS_DB: db,
      KV: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value) } },
      UPDATE_QUEUE: { send: async (message: unknown) => { sent.push(message) } },
      ...extra,
    } as unknown as Bindings
    await run(db, env, sent)
  } finally {
    await mf.dispose()
  }
}

test('a transient pipeline error is redispatched once per date, even after the recovery is adopted back', async () => {
  await withOps(async (db, env, sent) => {
    await db.batch([
      db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,last_error,updated_at)
        VALUES (?, 'pipeline_execution', 'pipeline-dispatch:2026-11-12:failed', 'error', ?, '2026-11-12 16:30:00')`).bind(DATE, D1_OVERLOADED),
      db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,updated_at)
        VALUES (?, 'post_screener_continuation', '2026-11-12-root', 'success', '2026-11-12 14:00:00')`).bind(DATE),
    ])
    const options = { businessDate: DATE, source: 'test-watchdog', nowMs: BEFORE_CUTOFF }
    const attempts = await Promise.all(Array.from({ length: 8 }, () => enqueuePostScreenerPipelineRecovery(env, options)))
    assert.equal(attempts.filter((result) => result.queued).length, 1)
    assert.equal(sent.length, 1)
    const queued = attempts.find((result) => result.queued)!
    assert.equal(queued.canonicalRunId, `pipeline-transient-recovery:${DATE}`)
    assert.equal(queued.reason, TRANSIENT_REDISPATCH_REASON)
    assert.equal(queued.lastError, D1_OVERLOADED)
    // The losing ticks see the winner's recovery in flight and must not read as blocked.
    for (const loser of attempts.filter((result) => !result.queued)) {
      assert.equal(loser.reason, 'transient_redispatch_in_flight')
      assert.equal(loser.status, 'queued')
    }
    const marker = await db.prepare(`SELECT canonical_run_id, status, cursor_key FROM pipeline_stage_runs
      WHERE business_date=? AND stage='pipeline_auto_redispatch'`).bind(DATE).first()
    assert.deepEqual(marker, { canonical_run_id: `pipeline-transient-recovery:${DATE}`, status: 'success',
      cursor_key: 'pipeline-dispatch:2026-11-12:failed' })

    // The redispatched run fails again: whether its continuation is adopted back to the root
    // or left in error under the recovery id, the CAS alone would pass; the marker must not.
    await db.prepare(`UPDATE pipeline_stage_runs SET canonical_run_id=?, status='error', last_error=?, updated_at='2026-11-12 18:00:00'
      WHERE business_date=? AND stage='pipeline_execution'`).bind('pipeline-dispatch:2026-11-12:retry', D1_OVERLOADED, DATE).run()
    for (const [runId, status] of [['2026-11-12-root', 'success'], [`pipeline-transient-recovery:${DATE}`, 'error']]) {
      await db.prepare(`UPDATE pipeline_stage_runs SET canonical_run_id=?, status=? WHERE business_date=? AND stage='post_screener_continuation'`)
        .bind(runId, status, DATE).run()
      const again = await enqueuePostScreenerPipelineRecovery(env, options)
      assert.equal(again.queued, false)
      assert.equal(again.reason, 'transient_redispatch_already_used')
      assert.equal(again.status, 'error')
    }
    assert.equal(sent.length, 1)
  })
})

test('a contract error keeps the existing no-retry decision and queues nothing', async () => {
  await withOps(async (db, env, sent) => {
    await db.batch([
      db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,last_error,updated_at)
        VALUES (?, 'pipeline_execution', 'failed', 'error', 'pipeline_modal_timexer_cardinality_mismatch', '2026-11-12 16:30:00')`).bind(DATE),
      db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,updated_at)
        VALUES (?, 'post_screener_continuation', 'root', 'success', '2026-11-12 14:00:00')`).bind(DATE),
    ])
    const result = await enqueuePostScreenerPipelineRecovery(env, { businessDate: DATE, source: 'test', nowMs: BEFORE_CUTOFF })
    assert.equal(result.queued, false)
    assert.equal(result.reason, 'pipeline_error_not_provenance_mismatch')
    assert.equal(result.status, 'error')
    assert.equal(sent.length, 0)
  })
})

test('an expired ambiguous dispatch with no Cloud Run execution is closed and redispatched once', async () => {
  const reconcileCalls: string[] = []
  let reason = 'exact_run_execution_not_found'
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    reconcileCalls.push(url.pathname)
    return new Response(JSON.stringify({ schema_version: 'pipeline-cloud-execution-status-v1', run_id: url.searchParams.get('run_id'),
      run_date: url.searchParams.get('date'), state: 'unknown', reason }), { status: 200 })
  }) as typeof fetch
  try {
    await withOps(async (db, env, sent) => {
      const attempt = 'pipeline-dispatch:2026-11-12:ambiguous'
      await db.batch([
        db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,lease_owner,lease_expires_at,updated_at)
          VALUES (?, 'pipeline_execution', ?, 'running', ?, '2026-11-12 18:00:00', '2026-11-12 16:00:00')`).bind(DATE, attempt, attempt),
        db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,updated_at)
          VALUES (?, 'post_screener_continuation', 'root', 'success', '2026-11-12 14:00:00')`).bind(DATE),
      ])
      // Lease still live (18:00Z), or the controller still sees the run: the reservation stays.
      const early = await enqueuePostScreenerPipelineRecovery(env, { businessDate: DATE, source: 'test', nowMs: Date.parse('2026-11-12T17:00:00Z') })
      assert.equal(early.reason, 'pipeline_not_error')
      for (reason of ['exact_run_observed', 'execution_scan_budget_exceeded']) {
        const observed = await enqueuePostScreenerPipelineRecovery(env, { businessDate: DATE, source: 'test', nowMs: BEFORE_CUTOFF })
        assert.equal(observed.reason, 'pipeline_not_error', reason)
      }
      // A reservation whose lease owner is not the run itself is not an ambiguous dispatch.
      reason = 'exact_run_execution_not_found'
      await db.prepare(`UPDATE pipeline_stage_runs SET lease_owner='someone-else' WHERE stage='pipeline_execution'`).run()
      const foreign = await enqueuePostScreenerPipelineRecovery(env, { businessDate: DATE, source: 'test', nowMs: BEFORE_CUTOFF })
      assert.equal(foreign.reason, 'pipeline_not_error')
      await db.prepare(`UPDATE pipeline_stage_runs SET lease_owner=canonical_run_id WHERE stage='pipeline_execution'`).run()
      assert.equal(sent.length, 0)

      reason = 'exact_run_execution_not_found'
      const result = await enqueuePostScreenerPipelineRecovery(env, { businessDate: DATE, source: 'test', nowMs: BEFORE_CUTOFF })
      assert.equal(result.queued, true)
      assert.equal(result.lastError, PIPELINE_DISPATCH_LOST_ERROR)
      assert.equal(sent.length, 1)
      const row = await db.prepare(`SELECT status, last_error, lease_owner FROM pipeline_stage_runs
        WHERE business_date=? AND stage='pipeline_execution'`).bind(DATE).first()
      assert.deepEqual(row, { status: 'error', last_error: PIPELINE_DISPATCH_LOST_ERROR, lease_owner: null })
      assert.ok(reconcileCalls.every((path) => path === '/pipeline/v2/reconcile'))
    }, { ML_CONTROLLER_URL: 'https://controller.test', ML_CONTROLLER_SECRET: 'test-secret' })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('pipeline recovery alerts write one ops warn per date and kind', async () => {
  await withOps(async (db, env) => {
    const queued = { queued: true, canonicalRunId: `pipeline-transient-recovery:${DATE}`, reason: TRANSIENT_REDISPATCH_REASON, lastError: D1_OVERLOADED }
    const blocked = { queued: false, canonicalRunId: 'root', reason: 'pipeline_error_not_provenance_mismatch', lastError: 'pipeline_stage_gpu_attempts_exhausted' }
    for (const recovery of [queued, queued, blocked, blocked]) await alertPipelineRecovery(env, DATE, recovery)
    const rows = await db.prepare(`SELECT level, cron_name, meta FROM system_logs ORDER BY id`).all<{ level: string; cron_name: string; meta: string }>()
    assert.deepEqual(rows.results.map((row) => [row.level, row.cron_name]),
      [['warn', 'pipeline-auto-redispatch'], ['warn', 'pipeline-error-no-auto-redispatch']])
    assert.equal(JSON.parse(rows.results[1].meta).reason, 'pipeline_error_not_provenance_mismatch')
  })
})
