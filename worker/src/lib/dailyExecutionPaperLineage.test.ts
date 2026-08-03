import assert from 'node:assert/strict'
import { writeDailyExecutionPaperClosureArtifacts } from './dailyExecutionPaperLineage'

function fakeDb(kind: 'legacy' | 'execution' | 'paper') {
  return {
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            async first() {
              if (sql.includes('paper_daily_snapshots')) {
                return kind === 'legacy'
                  ? { account_id: 1, date: '2026-08-03', cash: 966_998.13, positions_value: 0, total_value: 966_998.13, pnl: -33_001.87, pnl_pct: -3.300187 }
                  : null
              }
              return { count: 0 }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

async function run() {
  const writes: any[] = []
  const env = {
    DB: fakeDb('legacy'),
    EXECUTION_DB: fakeDb('execution'),
    PAPER_DB: fakeDb('paper'),
    MULTI_D1_ACTIVE_DOMAINS: '',
    EVIDENCE_ARTIFACT_WRITER: {
      async write(input: any) {
        writes.push(input)
        return {
          artifact_id: `artifact:${input.retentionClass}`,
          retention_class: input.retentionClass,
          status: 'ready',
          domain: input.domain,
          business_date: input.businessDate,
          producer_run_id: input.producerRunId,
          canonical_run_id: input.canonicalRunId,
          r2_key: `evidence/${input.retentionClass}.json`,
          checksum: 'sha256:test',
          schema_version: input.schemaVersion,
          row_count: input.rowCount,
          byte_size: 1,
          created_at: input.createdAt,
          retain_until: null,
          checksum_verified_at: input.createdAt,
          metadata_json: JSON.stringify(input.metadata ?? {}),
        }
      },
    },
  }

  const result = await writeDailyExecutionPaperClosureArtifacts(env as any, '2026-08-03')

  assert.equal(result.activity_status, 'no_activity')
  assert.equal(writes.length, 2)
  assert.equal(writes[0].retentionClass, 'canonical_execution')
  assert.equal(writes[0].rowCount, 0)
  assert.equal(writes[0].payload.activity_status, 'no_activity')
  assert.equal(writes[0].payload.real_order_effect, 'none')
  assert.equal(writes[1].retentionClass, 'paper_shadow')
  assert.equal(writes[1].rowCount, 1)
  assert.equal(writes[1].payload.legacy.snapshot.total_value, 966_998.13)
  assert.equal(writes[1].payload.routing.execution_target_schema_available, true)
  assert.equal(writes[1].payload.routing.paper_target_schema_available, true)
}

void run()
