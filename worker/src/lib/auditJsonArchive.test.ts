import { strict as assert } from 'node:assert'
import {
  AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
  runAuditJsonArchiveRetention,
} from './auditJsonArchive'

class FakeStatement {
  params: unknown[] = []

  constructor(
    private readonly db: FakeD1,
    readonly sql: string,
  ) {}

  bind(...params: unknown[]) {
    this.params = params
    return this
  }

  async all<T>() {
    if (this.sql.includes('FROM screener_funnel_items')) {
      return {
        results: [
          {
            id: 101,
            run_id: 'run-1',
            date: '2026-01-01',
            symbol: '2330',
            name: 'TSMC',
            stage: 'layer3_8ml_formal',
            decision: 'pass',
            reason_code: 'ok',
            score_before: 80,
            score_after: 82,
            rank: 1,
            evidence: JSON.stringify({ large: true, payload: 'x'.repeat(256) }),
            created_at: '2026-01-01T00:00:00Z',
            __blob_bytes: 300,
          },
        ] as T[],
      }
    }
    return { results: [] as T[] }
  }

  async first<T>() {
    void this
    return null as T | null
  }

  async run() {
    if (this.sql.includes('INSERT OR REPLACE INTO dataset_snapshots')) {
      this.db.manifestWrites += 1
      this.db.manifestParams.push(this.params)
    }
    return { meta: { changes: 1 } }
  }
}

class FakeD1 {
  manifestWrites = 0
  manifestParams: unknown[][] = []
  batchParams: unknown[][] = []

  prepare(sql: string) {
    return new FakeStatement(this, sql)
  }

  async batch(statements: FakeStatement[]) {
    for (const statement of statements) this.batchParams.push(statement.params)
    return statements.map(() => ({ meta: { changes: 1 } }))
  }
}

class FakeR2 {
  puts: Array<{ key: string; body: string; options: unknown }> = []

  async put(key: string, body: string, options: unknown) {
    this.puts.push({ key, body, options })
  }
}

async function main() {
  const dryDb = new FakeD1()
  const dryR2 = new FakeR2()
  const dryRun = await runAuditJsonArchiveRetention({
    DB: dryDb as any,
    ARTIFACTS: dryR2 as any,
  }, {
    businessDate: '2026-06-30',
    runId: 'dry-run',
    targets: ['screener_funnel_items'],
    dryRun: true,
  })

  assert.equal(dryRun.dry_run, true)
  assert.equal(dryR2.puts.length, 0)
  assert.equal(dryDb.manifestWrites, 0)
  assert.equal(dryDb.batchParams.length, 0)

  const db = new FakeD1()
  const r2 = new FakeR2()
  const confirmed = await runAuditJsonArchiveRetention({
    DB: db as any,
    ARTIFACTS: r2 as any,
  }, {
    businessDate: '2026-06-30',
    runId: 'confirmed-run',
    retentionDays: 90,
    limitPerTable: 10,
    targets: ['screener_funnel_items'],
    dryRun: false,
    confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
  })

  assert.equal(confirmed.dry_run, false)
  assert.equal(confirmed.total_archived_rows, 1)
  assert.equal(confirmed.total_scrubbed_rows, 1)
  assert.equal(r2.puts.length, 1)
  assert.match(r2.puts[0].key, /archives\/d1_audit_json_archive\/table=screener_funnel_items/)
  assert.match(r2.puts[0].body, /"screener_funnel_items"/)
  assert.match(r2.puts[0].body, /\\"large\\":true/)
  assert.equal(db.manifestWrites, 1)
  assert.equal(db.batchParams.length, 1)

  const pointer = JSON.parse(String(db.batchParams[0][0]))
  assert.equal(pointer.archived_to_r2, true)
  assert.equal(pointer.archive_kind, 'd1_audit_json_archive')
  assert.equal(pointer.table, 'screener_funnel_items')
  assert.equal(pointer.blob_column, 'evidence')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
