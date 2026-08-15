import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { loadExpectedReturnHistoryIntervalSummaries } from './expectedReturnPointerSemanticGuard'

type SqliteValue = string | number | bigint | Uint8Array | null

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values)
  }

  async all<T>(): Promise<{ results: T[] }> {
    return {
      results: this.db.prepare(this.sql).all(
        ...this.values as SqliteValue[],
      ) as unknown as T[],
    }
  }
}

test('bounded pointer history pages preserve interval, identity, and evidence semantics', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE model_artifact_registry(
      artifact_id TEXT PRIMARY KEY, model_name TEXT NOT NULL, version TEXT NOT NULL,
      artifact_path TEXT NOT NULL, checksum TEXT NOT NULL
    );
    CREATE TABLE expected_return_artifact_payloads(
      artifact_id TEXT PRIMARY KEY, payload_checksum TEXT NOT NULL, artifact_json TEXT NOT NULL
    );
    CREATE TABLE model_champion_history(
      event_id TEXT PRIMARY KEY, model_name TEXT NOT NULL, version TEXT NOT NULL,
      artifact_id TEXT, effective_at TEXT NOT NULL, retired_at TEXT,
      source TEXT NOT NULL, evidence_grade TEXT NOT NULL, evidence_json TEXT NOT NULL
    );
    CREATE INDEX idx_model_champion_history_semantic_scan
      ON model_champion_history(model_name, effective_at, event_id);
  `)
  const registry = db.prepare(`
    INSERT INTO model_artifact_registry(artifact_id, model_name, version, artifact_path, checksum)
    VALUES (?, ?, ?, ?, ?)
  `)
  const payload = db.prepare(`
    INSERT INTO expected_return_artifact_payloads(artifact_id, payload_checksum, artifact_json)
    VALUES (?, ?, ?)
  `)
  const history = db.prepare(`
    INSERT INTO model_champion_history(
      event_id, model_name, version, artifact_id, effective_at, retired_at,
      source, evidence_grade, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'model_champion_history', 'exact', ?)
  `)
  const insertOwner = (owner: string, count: number): void => {
    const instants = Array.from({ length: count }, (_, index) => (
      new Date(Date.UTC(2020, 0, 1 + index)).toISOString()
    ))
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(4, '0')
      const artifactId = `${owner}:artifact:${suffix}`
      const version = `v${suffix}`
      const artifactPath = `gs://${artifactId}`
      const checksum = `checksum-${suffix}`
      const payloadChecksum = `payload-${suffix}`
      if (index !== 129) {
        registry.run(
          artifactId,
          index === 109 ? 'wrong_owner' : owner,
          version,
          artifactPath,
          checksum,
        )
      }
      if (index !== 119) {
        payload.run(artifactId, payloadChecksum, '{"artifact_contract_version":"v1"}')
      }
      const evidence = JSON.stringify({
        schema_version: 'history-v1',
        owner,
        version,
        artifact_path: artifactPath,
        artifact_checksum: checksum,
        payload_checksum: index === 69 ? 'wrong-payload' : payloadChecksum,
        artifact_contract_version: 'v1',
      })
      history.run(
        `${owner}:event:${suffix}`,
        owner,
        version,
        artifactId,
        instants[index],
        index === count - 1
          ? null
          : index === 99
            ? instants[index]
            : instants[index + 1],
        evidence,
      )
    }
  }
  insertOwner('l4_alpha_ev', 251)
  insertOwner('allocator_ev_fusion', 1)

  const d1 = {
    prepare: (sql: string) => new SqliteStatement(db, sql),
  } as unknown as D1Database
  const summaries = await loadExpectedReturnHistoryIntervalSummaries(d1)
  const l4 = summaries.find((row) => row.model_name === 'l4_alpha_ev')
  const fusion = summaries.find((row) => row.model_name === 'allocator_ev_fusion')
  assert.deepEqual(l4, {
    model_name: 'l4_alpha_ev',
    total_rows: 251,
    open_rows: 1,
    invalid_intervals: 1,
    unresolved_registry_rows: 1,
    unresolved_payload_rows: 1,
    identity_mismatch_rows: 1,
    invalid_evidence_rows: 2,
  })
  assert.deepEqual(fusion, {
    model_name: 'allocator_ev_fusion',
    total_rows: 1,
    open_rows: 1,
    invalid_intervals: 0,
    unresolved_registry_rows: 0,
    unresolved_payload_rows: 0,
    identity_mismatch_rows: 0,
    invalid_evidence_rows: 0,
  })
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT event_id FROM model_champion_history
     WHERE model_name=? AND (
       effective_at > ? OR (effective_at=? AND event_id>?)
     )
     ORDER BY effective_at, event_id LIMIT 251
  `).all('l4_alpha_ev', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '') as Array<{
    detail?: string
  }>
  assert.match(plan.map((row) => row.detail ?? '').join('\n'), /idx_model_champion_history_semantic_scan/)
  history.run(
    null,
    'l4_alpha_ev',
    'null-event-version',
    null,
    '2030-01-01T00:00:00.000Z',
    null,
    '{"schema_version":"history-v1"}',
  )
  await assert.rejects(
    loadExpectedReturnHistoryIntervalSummaries(d1),
    /history_event_id_null:l4_alpha_ev:1/,
  )
  db.close()
})
