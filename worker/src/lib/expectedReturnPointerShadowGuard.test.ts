import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bindings } from '../types'
import { DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION } from './dataDomainControlRevision'
import {
  DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
  DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
  DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
  isExpectedReturnSemanticControlTable,
} from './dataDomainShadowManifest'
import {
  assertExpectedReturnPointerSourceStable,
  beginExpectedReturnPointerShadowGuard,
  type ExpectedReturnPointerShadowGuard,
} from './expectedReturnPointerShadowGuard'

const PARENTS = [
  'model_artifact_registry',
  'expected_return_artifact_payloads',
  'model_champion_history',
] as const

class GuardStatement {
  constructor(
    private readonly db: GuardDb,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): GuardStatement {
    return new GuardStatement(this.db, this.sql, values)
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null
  }
}

class GuardDb {
  readonly batches: GuardStatement[][] = []

  constructor(
    private readonly side: 'source' | 'target',
    private readonly registryRevision: number,
  ) {}

  prepare(sql: string): GuardStatement {
    return new GuardStatement(this, sql)
  }

  async batch(statements: GuardStatement[]): Promise<unknown[]> {
    this.batches.push(statements)
    return statements.map(() => ({ success: true }))
  }

  first(sql: string, values: readonly unknown[]): unknown {
    if (/SELECT\s+status\s+FROM\s+data_domain_cutovers/i.test(sql)) {
      if (this.side !== 'source') throw new Error(`unexpected_target_cutover:${sql}`)
      return { status: 'legacy' }
    }
    const table = String(values[0] ?? '')
    if (/FROM\s+data_domain_backfill_cursors/i.test(sql)) {
      const checksum = 'a'.repeat(64)
      return {
        status: 'complete',
        cursor_json: null,
        rows_copied: 1,
        last_source_checksum: checksum,
        last_target_checksum: checksum,
      }
    }
    if (/FROM\s+data_domain_parity_checks/i.test(sql)) {
      const checksum = 'a'.repeat(64)
      return {
        status: 'pass',
        source_count: 1,
        target_count: 1,
        source_checksum: checksum,
        target_checksum: checksum,
        checked_at: '2026-08-15 10:00:00',
        evidence_json: JSON.stringify({
          schema_version: DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
          parity_scope: 'resumable_full_table_manifest',
          manifest_schema_version: DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
          manifest_page_limit: 25,
          revision_schema_version: DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION,
          source_revision: 1,
          target_revision: 1,
          ...(isExpectedReturnSemanticControlTable(table) ? {
            semantic_validation_schema_version:
              DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
            semantic_validation_status: 'pass',
            semantic_rows_scanned: 1,
            semantic_rows_applicable: 1,
            semantic_rows_validated: 1,
          } : {}),
        }),
      }
    }
    if (/SELECT\s+COUNT\(\*\)\s+count\s+FROM/i.test(sql)) return { count: 1 }
    if (/FROM\s+data_domain_control_revisions/i.test(sql)) {
      return {
        revision: table === 'model_artifact_registry'
          ? this.registryRevision
          : 1,
      }
    }
    throw new Error(`unexpected_guard_first:${this.side}:${sql}`)
  }
}

test('pointer preflight rejects same-count parent revision drift before semantic reads', async () => {
  const source = new GuardDb('source', 2)
  const target = new GuardDb('target', 1)
  const env = {
    DB: source as unknown as D1Database,
    LEARNING_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings

  await assert.rejects(
    beginExpectedReturnPointerShadowGuard(
      env,
      target as unknown as D1Database,
      '2026-08-15T10:00:00.000Z',
    ),
    /model_artifact_registry:source_revision_stale:1\/2/,
  )

  assert.equal(source.batches.length, 1)
  const mutationText = source.batches[0]
    .flatMap((statement) => [statement.sql, ...statement.values.map(String)])
    .join('\n')
  assert.match(mutationText, /model_artifact_registry/)
  assert.match(mutationText, /model_champion_pointers/)
  for (const table of PARENTS.slice(1)) assert.doesNotMatch(mutationText, new RegExp(table))
})

test('pointer source-stability check rejects parent revision drift after preflight', async () => {
  const source = new GuardDb('source', 2)
  const target = new GuardDb('target', 1)
  const env = {
    DB: source as unknown as D1Database,
    LEARNING_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings
  const guard = {
    authority: { domain: 'learning', strict: false, active: false },
    sourceBefore: {} as never,
    target: target as unknown as D1Database,
    parentRevisions: {
      model_artifact_registry: { sourceRevision: 1, targetRevision: 1 },
      expected_return_artifact_payloads: { sourceRevision: 1, targetRevision: 1 },
      model_champion_history: { sourceRevision: 1, targetRevision: 1 },
    },
  } satisfies ExpectedReturnPointerShadowGuard

  await assert.rejects(
    assertExpectedReturnPointerSourceStable(env, guard),
    /parent_revision_drift:model_artifact_registry:source_revision:1\/2/,
  )
  assert.equal(source.batches.length, 1)
  const mutationText = source.batches[0]
    .flatMap((statement) => [statement.sql, ...statement.values.map(String)])
    .join('\n')
  assert.match(mutationText, /model_artifact_registry/)
  assert.match(mutationText, /model_champion_pointers/)
})
