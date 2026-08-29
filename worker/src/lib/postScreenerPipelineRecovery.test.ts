import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import type { Bindings } from '../types'
import { enqueuePostScreenerPipelineRecovery } from './postScreenerContinuation'

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
