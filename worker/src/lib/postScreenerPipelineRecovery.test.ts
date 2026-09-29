import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import type { Bindings } from '../types'
import {
  enqueuePostScreenerPipelineContinuation,
  enqueuePostScreenerPipelineRecovery,
  pipelineProvenanceRecoveryDecision,
} from './postScreenerContinuation'

test('pipeline provenance recovery is exact-error CAS fenced and once per Worker release', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['OPS'],
  })
  try {
    const db = await mf.getD1Database('OPS')
    await db.prepare(`
      CREATE TABLE pipeline_stage_runs (
        business_date TEXT NOT NULL,
        stage TEXT NOT NULL,
        canonical_run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cursor_key TEXT,
        processed_count INTEGER NOT NULL DEFAULT 0,
        expected_count INTEGER,
        persisted_count INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        queued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (business_date, stage)
      )
    `).run()
    await db.batch([
      db.prepare(`
        INSERT INTO pipeline_stage_runs (
          business_date, stage, canonical_run_id, status, last_error, updated_at
        ) VALUES (?, 'pipeline_execution', ?, 'error', ?, ?)
      `).bind(
        '2026-08-28',
        'pipeline-dispatch:2026-08-28:failed',
        'ValueError: pipeline_modal_source_sha_mismatch',
        '2026-08-28 13:48:34',
      ),
      db.prepare(`
        INSERT INTO pipeline_stage_runs (
          business_date, stage, canonical_run_id, status, updated_at
        ) VALUES (?, 'post_screener_continuation', ?, 'success', ?)
      `).bind('2026-08-28', '2026-08-28-root', '2026-08-28 13:45:00'),
    ])

    const kvRows = new Map<string, string>()
    const sent: unknown[] = []
    const env = {
      DB: db,
      OPS_DB: db,
      CF_VERSION_METADATA: {
        id: 'worker-release-a',
        tag: 'b'.repeat(40),
        timestamp: '2026-08-28T15:38:10.000Z',
      },
      KV: {
        get: async (key: string) => {
          const value = kvRows.get(key)
          return value == null ? null : JSON.parse(value)
        },
        put: async (key: string, value: string) => { kvRows.set(key, value) },
      },
      UPDATE_QUEUE: {
        send: async (message: unknown) => { sent.push(message) },
      },
    } as unknown as Bindings

    const attempts = await Promise.all(Array.from({ length: 8 }, () => (
      enqueuePostScreenerPipelineRecovery(env, {
        businessDate: '2026-08-28',
        workerVersion: env.CF_VERSION_METADATA,
        source: 'test-watchdog',
      })
    )))
    assert.equal(attempts.filter((result) => result.queued).length, 1)
    assert.equal(sent.length, 1)
    assert.equal(
      new Set(attempts.map((result) => result.canonicalRunId)).size,
      1,
    )

    const canonical = await db.prepare(`
      SELECT canonical_run_id, status
        FROM pipeline_stage_runs
       WHERE business_date='2026-08-28' AND stage='post_screener_continuation'
    `).first<{ canonical_run_id: string; status: string }>()
    assert.equal(canonical?.canonical_run_id, 'pipeline-provenance-recovery:2026-08-28:worker-release-a')
    assert.equal(canonical?.status, 'queued')

    await db.prepare(`
      UPDATE pipeline_stage_runs
         SET status='success', updated_at=CURRENT_TIMESTAMP
       WHERE business_date='2026-08-28' AND stage='post_screener_continuation'
    `).run()
    const duplicate = await enqueuePostScreenerPipelineRecovery(env, {
      businessDate: '2026-08-28',
      workerVersion: env.CF_VERSION_METADATA,
      source: 'test-watchdog',
    })
    assert.equal(duplicate.queued, false)
    assert.equal(duplicate.reason, 'release_recovery_already_claimed')
    assert.equal(sent.length, 1)

    const newerVersion = {
      id: 'worker-release-b',
      tag: 'c'.repeat(40),
      timestamp: '2026-08-28T16:10:00.000Z',
    }
    const nextRelease = await enqueuePostScreenerPipelineRecovery(env, {
      businessDate: '2026-08-28',
      workerVersion: newerVersion,
      source: 'test-watchdog',
    })
    assert.equal(nextRelease.queued, true)
    assert.equal(sent.length, 2)
  } finally {
    await mf.dispose()
  }
})

test('stale queued post-screener continuation is re-enqueued once and remains lease-deduplicated', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['OPS'],
  })
  try {
    const db = await mf.getD1Database('OPS')
    await db.prepare(`
      CREATE TABLE pipeline_stage_runs (
        business_date TEXT NOT NULL,
        stage TEXT NOT NULL,
        canonical_run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cursor_key TEXT,
        processed_count INTEGER NOT NULL DEFAULT 0,
        expected_count INTEGER,
        persisted_count INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        queued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (business_date, stage)
      )
    `).run()
    await db.prepare(`
      INSERT INTO pipeline_stage_runs (
        business_date, stage, canonical_run_id, status, queued_at, updated_at
      ) VALUES ('2026-09-02', 'post_screener_continuation', 'chain-1', 'queued',
                datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))
    `).run()

    const kvRows = new Map<string, string>()
    const sent: unknown[] = []
    const env = {
      DB: db,
      OPS_DB: db,
      KV: {
        get: async (key: string) => {
          const value = kvRows.get(key)
          return value == null ? null : JSON.parse(value)
        },
        put: async (key: string, value: string) => { kvRows.set(key, value) },
      },
      UPDATE_QUEUE: {
        send: async (message: unknown) => { sent.push(message) },
      },
    } as unknown as Bindings

    const recovered = await enqueuePostScreenerPipelineContinuation(env, {
      triggerTime: '2026-09-02',
      runId: 'chain-1',
      source: 'watchdog-test',
    })
    assert.equal(recovered.queued, true)
    assert.equal(recovered.status, 'requeued')
    assert.equal(sent.length, 1)

    const duplicate = await enqueuePostScreenerPipelineContinuation(env, {
      triggerTime: '2026-09-02',
      runId: 'chain-1',
      source: 'watchdog-test-duplicate',
    })
    assert.equal(duplicate.queued, false)
    assert.equal(duplicate.status, 'queued')
    assert.equal(sent.length, 1, 'a fresh requeue must not emit a duplicate message before the recovery threshold')
  } finally {
    await mf.dispose()
  }
})

for (const error of ['active8_ensemble_base_identity_mismatch:DLinear', 'active8_ensemble_base_not_serving:PatchTST:artifact_sequence_contract_missing_or_invalid']) {
  test(`serving contract recovery requires a newer release: ${error}`, () => {
    const failure = {canonical_run_id:'failed-run',status:'error',last_error:error,updated_at:'2026-09-09 13:46:18'};
    const workerVersion = {id:'new-release',tag:'a'.repeat(40),timestamp:'2026-09-09T14:00:00Z'};
    assert.equal(pipelineProvenanceRecoveryDecision({failure,workerVersion}).retry,true);
    assert.equal(pipelineProvenanceRecoveryDecision({failure,workerVersion:{...workerVersion,timestamp:'2026-09-09T13:00:00Z'}}).retry,false);
    assert.equal(pipelineProvenanceRecoveryDecision({failure:{...failure,status:'running'},workerVersion}).retry,false);
    assert.equal(pipelineProvenanceRecoveryDecision({failure:{...failure,last_error:'unrelated failure'},workerVersion}).retry,false);
  });
}

test('Paper runtime drift recovers only after exact reapproval and a newer Worker release', () => {
  const failure = {canonical_run_id:'failed-run',status:'error',
    last_error:'active8_nav_current_configuration_changed_or_unverified',
    updated_at:'2026-09-29 14:03:05'}
  const workerVersion = {id:'new-release',tag:'a'.repeat(40),timestamp:'2026-09-29T15:00:00Z'}
  const runtimeApproval = {schema_version:'active8-paper-runtime-approval-v1',approved:true,
    approved_at:'2026-09-29T14:30:00Z',approved_execution_policy_change:{
      schema_version:'active8-paper-odd-lot-quote-age-change-v1',
      variable:'FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS',previous:'absent',approved:'10000'}}
  const decide = (overrides: Record<string, unknown> = {}) =>
    pipelineProvenanceRecoveryDecision({failure,workerVersion,runtimeApproval,...overrides})
  assert.equal(decide().reason,'new_worker_release_after_paper_runtime_reapproval')
  assert.equal(decide().retry,true)
  assert.equal(decide({runtimeApproval:null}).retry,false)
  assert.equal(decide({runtimeApproval:{...runtimeApproval,approved_at:'2026-09-29T14:00:00Z'}}).retry,false)
  assert.equal(decide({runtimeApproval:{...runtimeApproval,approved_execution_policy_change:{
    ...runtimeApproval.approved_execution_policy_change,approved:'20000'}}}).retry,false)
  assert.equal(decide({workerVersion:{...workerVersion,timestamp:'2026-09-29T14:00:00Z'}}).retry,false)
  assert.equal(decide({failure:{...failure,last_error:'unrelated failure'}}).retry,false)
})

test('Paper runtime reapproval requeues the failed pipeline stage once', async () => {
  const mf = new Miniflare({modules:true,
    script:'export default { fetch() { return new Response("ok") } }',d1Databases:['OPS']})
  try {
    const db = await mf.getD1Database('OPS')
    await db.prepare(`CREATE TABLE pipeline_stage_runs (
      business_date TEXT NOT NULL, stage TEXT NOT NULL, canonical_run_id TEXT NOT NULL,
      status TEXT NOT NULL, cursor_key TEXT, processed_count INTEGER NOT NULL DEFAULT 0,
      expected_count INTEGER, persisted_count INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT,
      queued_at TEXT, started_at TEXT, completed_at TEXT, last_error TEXT,
      updated_at TEXT NOT NULL, PRIMARY KEY (business_date, stage))`).run()
    await db.batch([
      db.prepare(`INSERT INTO pipeline_stage_runs
        (business_date,stage,canonical_run_id,status,last_error,updated_at)
        VALUES ('2026-09-29','pipeline_execution','failed-run','error',?,?)`)
        .bind('active8_nav_current_configuration_changed_or_unverified','2026-09-29 14:03:05'),
      db.prepare(`INSERT INTO pipeline_stage_runs
        (business_date,stage,canonical_run_id,status,updated_at)
        VALUES ('2026-09-29','post_screener_continuation','original-root','success',?)`)
        .bind('2026-09-29 14:02:07'),
    ])
    const sent: unknown[] = []
    const approval = {schema_version:'active8-paper-runtime-approval-v1',approved:true,
      approved_at:'2026-09-29T14:30:00Z',approved_execution_policy_change:{
        schema_version:'active8-paper-odd-lot-quote-age-change-v1',
        variable:'FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS',previous:'absent',approved:'10000'}}
    const env = {DB:db,OPS_DB:db,KV:{
      get:async (key:string) => key === 'ml:active8:paper_runtime_approval:v1' ? approval : null,
      put:async () => {},
    },UPDATE_QUEUE:{send:async (message:unknown) => { sent.push(message) }}} as unknown as Bindings
    const options = {businessDate:'2026-09-29',source:'test',
      workerVersion:{id:'repair-release',tag:'a'.repeat(40),timestamp:'2026-09-29T15:00:00Z'}}
    const first = await enqueuePostScreenerPipelineRecovery(env,options)
    const duplicate = await enqueuePostScreenerPipelineRecovery(env,options)
    assert.equal(first.queued,true)
    assert.equal(duplicate.queued,false)
    assert.equal(sent.length,1)
    assert.equal(first.canonicalRunId,'pipeline-provenance-recovery:2026-09-29:repair-release')
  } finally {
    await mf.dispose()
  }
})
