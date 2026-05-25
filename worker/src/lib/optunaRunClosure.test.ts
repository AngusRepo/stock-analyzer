import assert from 'node:assert/strict'
import { closeOptunaQueueCallbackRun, resolveOptunaCallbackRunDate } from './optunaRunClosure'

class FakeD1 {
  locks = new Map<string, Record<string, string | null>>()
  manifests = new Map<string, Record<string, unknown>>()

  prepare(sql: string): any {
    const db = this
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values
        return this
      },
      async run() {
        if (sql.includes('UPDATE scheduler_locks')) {
          const [owner, expiresAt, lockKey] = this.values.map(v => v == null ? null : String(v))
          const existing = db.locks.get(String(lockKey))
          if (!existing) return { success: true, results: [], meta: { changes: 0 } }
          db.locks.set(String(lockKey), { ...existing, owner, expires_at: expiresAt })
          return { success: true, results: [], meta: { changes: 1 } }
        }
        if (sql.includes('INSERT OR REPLACE INTO dataset_snapshots')) {
          const [snapshotId, kind, businessDate, marketSegment, schemaVersion, rowCount, checksum, primaryStore, accessTier, gcsUri, r2Key, producerRunId, status, metadataJson] = this.values
          db.manifests.set(String(snapshotId), {
            snapshot_id: snapshotId,
            kind,
            business_date: businessDate,
            market_segment: marketSegment,
            schema_version: schemaVersion,
            row_count: rowCount,
            checksum,
            primary_store: primaryStore,
            access_tier: accessTier,
            gcs_uri: gcsUri,
            r2_key: r2Key,
            producer_run_id: producerRunId,
            status,
            metadata_json: metadataJson,
          })
          return { success: true, results: [], meta: { changes: 1 } }
        }
        throw new Error(`unsupported sql: ${sql}`)
      },
    }
  }
}

class FakeR2 {
  objects = new Map<string, string>()

  async put(key: string, body: string): Promise<void> {
    this.objects.set(key, body)
  }
}

async function main() {
  const runId = 'per_regime:regime_shift:volatile:2026-05-24'
  assert.equal(resolveOptunaCallbackRunDate({ runId }), '2026-05-24')

  const fakeD1 = new FakeD1()
  const fakeR2 = new FakeR2()
  fakeD1.locks.set(`optuna:run:${runId}`, {
    lock_key: `optuna:run:${runId}`,
    owner: 'optuna_per_regime_run',
    run_date: '2026-05-24',
    run_id: runId,
    created_at: '2026-05-24T00:00:00.000Z',
    expires_at: '2026-05-24T06:00:00.000Z',
  })

  const result = await closeOptunaQueueCallbackRun({
    DB: fakeD1 as unknown as D1Database,
    ARTIFACTS: fakeR2 as any,
  }, {
    status: 'success',
    runId,
    summary: 'per_regime modal completed robust_sharpe=1.23',
    durationMs: 1234,
    metadata: {
      executor: 'modal',
      robust_sharpe: 1.23,
    },
  })

  assert.equal(result.closed, true)
  assert.equal(result.artifact_written, true)
  assert.equal(result.business_date, '2026-05-24')
  assert.equal(fakeD1.locks.get(`optuna:run:${runId}`)?.owner, 'optuna_per_regime_run_success')
  const key = `reports/optuna_queue_run_report/business_date=2026-05-24/run_id=${runId}.json`
  const artifact = fakeR2.objects.get(key)
  assert.ok(artifact)
  assert.match(artifact, /optuna_per_regime_callback/)
  assert.match(artifact, /d1_run_lock_closed/)
  assert.match(artifact, /robust_sharpe/)
  assert.ok(fakeD1.manifests.get(`optuna_queue_run_report:2026-05-24:${runId}`))

  const running = await closeOptunaQueueCallbackRun({
    DB: fakeD1 as unknown as D1Database,
    ARTIFACTS: fakeR2 as any,
  }, {
    status: 'running',
    runId: 'per_regime:manual:all:2026-05-24',
  })
  assert.equal(running.closed, false)
  assert.equal(running.artifact_written, false)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
