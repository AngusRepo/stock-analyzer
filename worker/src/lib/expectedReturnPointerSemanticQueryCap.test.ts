import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  EXPECTED_RETURN_HISTORY_MAX_PAGES_PER_OWNER,
  EXPECTED_RETURN_POINTER_GUARD_MAX_SEMANTIC_SQL_STATEMENTS,
  EXPECTED_RETURN_SEMANTIC_SNAPSHOT_MAX_SQL_STATEMENTS,
  loadExpectedReturnSemanticSnapshot,
  type ExpectedReturnPointerRow,
} from './expectedReturnPointerSemanticGuard'

type SqlCapMode = 'normal' | 'history_cap' | 'revision_drift'

class SqlCapStatement {
  constructor(
    private readonly db: SqlCapDb,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqlCapStatement {
    return new SqlCapStatement(this.db, this.sql, values)
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql, this.values) as T[] }
  }
}

class SqlCapDb {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = []
  pageCalls = 0
  private revisionReads = 0

  constructor(private readonly mode: SqlCapMode = 'normal') {}

  prepare(sql: string): SqlCapStatement {
    return new SqlCapStatement(this, sql)
  }

  first(sql: string, values: readonly unknown[]): unknown {
    this.statements.push({ sql, values })
    if (!/FROM\s+data_domain_control_revisions/i.test(sql)) {
      throw new Error(`unexpected_sql_cap_first:${sql}`)
    }
    const table = String(values[0] ?? '')
    const afterSnapshot = this.revisionReads >= 4
    this.revisionReads += 1
    return {
      revision: this.mode === 'revision_drift'
        && afterSnapshot
        && table === 'model_champion_history'
        ? 2
        : 1,
    }
  }

  all(sql: string, values: readonly unknown[]): unknown[] {
    this.statements.push({ sql, values })
    if (/FROM\s+model_champion_pointers/i.test(sql)) {
      return [
        {
          model_name: 'l4_alpha_ev',
          champion_version: 'v5',
          champion_artifact_id: 'l4:v5',
          rollback_version: 'v4',
          rollback_artifact_id: 'l4:v4',
          promoted_at: '2026-08-15 10:00:00',
          promotion_reason: 'test',
          promotion_evidence_json: '{}',
        },
        {
          model_name: 'allocator_ev_fusion',
          champion_version: 'v14',
          champion_artifact_id: 'fusion:v14',
          rollback_version: null,
          rollback_artifact_id: null,
          promoted_at: '2026-08-15 10:00:00',
          promotion_reason: 'test',
          promotion_evidence_json: '{}',
        },
      ] satisfies ExpectedReturnPointerRow[]
    }
    if (/WITH\s+candidate\s+AS/i.test(sql)) {
      this.pageCalls += 1
      if (this.mode !== 'history_cap') return []
      const suffix = String(this.pageCalls).padStart(4, '0')
      return [{
        total_rows: 250,
        null_event_id_rows: 0,
        open_rows: 0,
        invalid_intervals: 0,
        unresolved_registry_rows: 0,
        unresolved_payload_rows: 0,
        identity_mismatch_rows: 0,
        invalid_evidence_rows: 0,
        page_has_more: 1,
        page_last_effective_at: `2026-08-15 10:${suffix}`,
        page_last_event_id: `event-${suffix}`,
      }]
    }
    return []
  }
}

test('pointer semantic snapshot uses revision-sandwiched bounded history SQL', async () => {
  const db = new SqlCapDb()
  await loadExpectedReturnSemanticSnapshot(db as unknown as D1Database)

  assert.equal(EXPECTED_RETURN_SEMANTIC_SNAPSHOT_MAX_SQL_STATEMENTS, 212)
  assert.equal(EXPECTED_RETURN_POINTER_GUARD_MAX_SEMANTIC_SQL_STATEMENTS, 848)
  assert(EXPECTED_RETURN_POINTER_GUARD_MAX_SEMANTIC_SQL_STATEMENTS < 1000)
  assert.equal(db.statements.length, 14)
  assert(db.statements.every(({ values }) => values.length <= 12))
  const revisionStatements = db.statements.filter(({ sql }) => (
    /FROM\s+data_domain_control_revisions/i.test(sql)
  ))
  assert.equal(revisionStatements.length, 8)
  const historyStatements = db.statements.filter(({ sql }) => (
    /FROM\s+model_champion_history/i.test(sql)
  ))
  assert.equal(historyStatements.length, 3)
  const boundedRows = historyStatements.find(({ sql }) => /SELECT\s+event_id/i.test(sql))
  assert(boundedRows)
  assert.match(boundedRows.sql, /ORDER BY[\s\S]+LIMIT\s+25/i)
  const paged = historyStatements.filter(({ sql }) => /WITH\s+candidate\s+AS/i.test(sql))
  assert.equal(paged.length, 2)
  for (const statement of paged) {
    assert.match(statement.sql, /h\.model_name=\?/i)
    assert.match(statement.sql, /next\.effective_at[\s\S]+next\.event_id/i)
    assert.match(statement.sql, /LIMIT\s+\?/i)
    assert.doesNotMatch(statement.sql, /LEAD\s*\(/i)
    assert.doesNotMatch(statement.sql, /SELECT\s+\*\s+FROM\s+model_champion_history/i)
  }
  const legacyIndex = fs.readFileSync(
    'migrations/0109_expected_return_history_semantic_scan_index.sql',
    'utf8',
  )
  const learningIndex = fs.readFileSync(
    'domain-migrations/learning/0007_expected_return_history_semantic_scan_index.sql',
    'utf8',
  )
  for (const migration of [legacyIndex, learningIndex]) {
    assert.match(
      migration,
      /model_champion_history\(model_name, effective_at, event_id\)/,
    )
  }
})

test('pointer semantic snapshot fails closed at the per-owner history page cap', async () => {
  const db = new SqlCapDb('history_cap')
  await assert.rejects(
    loadExpectedReturnSemanticSnapshot(db as unknown as D1Database),
    /expected_return_pointer_shadow_guard_history_cap_exceeded:l4_alpha_ev:25000/,
  )
  assert.equal(db.pageCalls, EXPECTED_RETURN_HISTORY_MAX_PAGES_PER_OWNER)
  assert(db.statements.length < 1000)
})

test('pointer semantic snapshot rejects revision drift across paginated reads', async () => {
  const db = new SqlCapDb('revision_drift')
  await assert.rejects(
    loadExpectedReturnSemanticSnapshot(db as unknown as D1Database),
    /semantic_snapshot_revision_drift:model_champion_history:1\/2/,
  )
})
