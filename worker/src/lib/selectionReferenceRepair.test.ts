import assert from 'node:assert/strict'
import { repairHistoricalSelectionReferences } from './selectionReferenceRepair'

function fakeDb(coverageCount = 5): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          if (sql.includes('FROM canonical_run_heads')) {
            return {
              async first() {
                return {
                  producer_run_id: 'screener-2026-07-15-canonical',
                  expected_rows: 5,
                  source_artifact_id: 'artifact:screener_funnel:2026-07-15:abc',
                  source_artifact_checksum: 'sha256:abc',
                  source_artifact_schema: 'screener-funnel-evidence-v2',
                }
              },
            }
          }
          if (sql.includes('FROM screener_funnel_items') && sql.includes('symbol_count')) {
            return {
              async first() {
                return {
                  row_count: coverageCount,
                  symbol_count: coverageCount,
                  pass_count: coverageCount,
                  valid_evidence_count: coverageCount,
                  score_v2_count: coverageCount,
                }
              },
            }
          }
          if (sql.includes('FROM selection_reference_snapshots_v1')) {
            return { async first() { return { row_count: 0 } } }
          }
          throw new Error('unexpected SQL: ' + sql)
        },
      }
    },
  } as unknown as D1Database
}

async function main(): Promise<void> {
  const result = await repairHistoricalSelectionReferences(fakeDb(), '2026-07-15', { dryRun: true })
  assert.equal(result.expected_rows, 5)
  assert.equal(result.persisted_rows, 0)
  assert.equal(result.source_artifact_schema, 'screener-funnel-evidence-v2')
  assert.equal(result.strategy_matrix_status, 'unavailable')
  assert.equal(result.dry_run, true)

  await assert.rejects(
    () => repairHistoricalSelectionReferences(fakeDb(4), '2026-07-15', { dryRun: true }),
    /selection_reference_repair_scoring_coverage_mismatch:4\/4\/4\/4\/4\/5/,
  )
  console.log('selection reference repair tests passed')
}

void main()