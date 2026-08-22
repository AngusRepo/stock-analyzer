import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bindings } from '../types'
import { readExternalEvidenceMaterializationReceipt } from './controllerResearchWorkflows'

function readbackDb(row: Record<string, unknown> | null): D1Database {
  return {
    prepare: (sql: string) => {
      assert.match(sql, /source_quality_metrics/)
      assert.match(sql, /stock_theme_features/)
      return {
        bind: (...params: unknown[]) => {
          assert.deepEqual(params, ['2026-08-21', '2026-08-21', '2026-08-21'])
          return { first: async () => row }
        },
      }
    },
  } as unknown as D1Database
}

function envFor(row: Record<string, unknown> | null): Bindings {
  return {
    DB: readbackDb(null),
    MARKET_DB: readbackDb(row),
    MULTI_D1_ACTIVE_DOMAINS: 'market',
    MULTI_D1_STRICT: 'true',
  } as unknown as Bindings
}

test('524 fallback accepts only a complete same-run Market D1 receipt', async () => {
  const receipt = await readExternalEvidenceMaterializationReceipt(envFor({
    generated_at: '2026-08-22T08:31:20.317830+00:00',
    source_quality_rows: 3,
    theme_rows: 214,
    feature_rows: 498,
  }), '2026-08-21')

  assert.equal(receipt?.status, 'ready')
  assert.equal(receipt?.schema_version, 'external-evidence-d1-readback-receipt-v1')
  assert.equal(receipt?.recovery_reason, 'controller_http_524_after_origin_commit')

  const stale = await readExternalEvidenceMaterializationReceipt(envFor({
    generated_at: '2026-08-22T08:31:20.317830+00:00',
    source_quality_rows: 3,
    theme_rows: 214,
    feature_rows: 498,
  }), '2026-08-21', '2026-08-22T08:32:00.000Z')
  assert.equal(stale, null)

  const incomplete = await readExternalEvidenceMaterializationReceipt(envFor({
    generated_at: '2026-08-22T08:31:20.317830+00:00',
    source_quality_rows: 3,
    theme_rows: 214,
    feature_rows: 0,
  }), '2026-08-21')
  assert.equal(incomplete, null)
})
