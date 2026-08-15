import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { Bindings } from '../types'
import { backfillDataDomainTableShadow } from './dataDomainShadowBackfill'
import { checksumText } from './dataDomainShadowManifest'

type SqliteValue = string | number | bigint | Uint8Array | null

function sqliteValue(value: unknown): SqliteValue {
  if (value == null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  throw new Error(`unsupported_sqlite_value:${typeof value}`)
}

class SqliteStatement {
  constructor(
    private readonly db: SqliteD1,
    private readonly sql: string,
    private readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values)
  }

  async first<T>(): Promise<T | null> {
    this.db.observe(this.sql, this.values)
    const row = this.db.raw.prepare(this.sql).get(...this.values.map(sqliteValue))
    return (row ?? null) as unknown as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    this.db.observe(this.sql, this.values)
    const rows = this.db.raw.prepare(this.sql).all(...this.values.map(sqliteValue))
    return { results: rows as unknown as T[] }
  }

  async run(): Promise<unknown> {
    return this.runSync()
  }

  runSync(): unknown {
    this.db.observe(this.sql, this.values)
    const result = this.db.raw.prepare(this.sql).run(...this.values.map(sqliteValue))
    return { success: true, results: [], meta: { changes: Number(result.changes) } }
  }
}

class SqliteD1 {
  readonly raw = new DatabaseSync(':memory:')
  readonly observations: Array<{ sql: string; values: readonly unknown[] }> = []

  constructor() {
    this.raw.exec('PRAGMA foreign_keys=ON')
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this, sql)
  }

  observe(sql: string, values: readonly unknown[]): void {
    this.observations.push({ sql, values })
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec('BEGIN')
    try {
      const results = statements.map((statement) => statement.runSync())
      this.raw.exec('COMMIT')
      return results
    } catch (error) {
      this.raw.exec('ROLLBACK')
      throw error
    }
  }
}

function installLearningArtifactTables(db: SqliteD1): void {
  db.raw.exec(`
    CREATE TABLE model_artifact_registry(
      artifact_id TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      version TEXT NOT NULL,
      state TEXT NOT NULL,
      artifact_path TEXT,
      training_run_id TEXT,
      feature_policy_version TEXT,
      checksum TEXT,
      offline_evidence_json TEXT,
      marker TEXT NOT NULL
    );
    CREATE TABLE expected_return_artifact_payloads(
      artifact_id TEXT PRIMARY KEY
        REFERENCES model_artifact_registry(artifact_id) ON DELETE RESTRICT,
      model_name TEXT NOT NULL,
      model_version TEXT NOT NULL,
      serving_mode TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      payload_checksum TEXT NOT NULL,
      source_artifact_path TEXT,
      source_artifact_checksum TEXT,
      source_cohort_id TEXT,
      marker TEXT NOT NULL
    );
  `)
}

function installControlPlane(db: SqliteD1): void {
  db.raw.exec(`
    CREATE TABLE data_domain_cutovers(
      domain TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      source_binding TEXT,
      target_binding TEXT,
      source_row_count INTEGER,
      target_row_count INTEGER,
      source_checksum TEXT,
      target_checksum TEXT,
      parity_checked_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE data_domain_backfill_cursors(
      domain TEXT NOT NULL,
      table_name TEXT NOT NULL,
      status TEXT NOT NULL,
      cursor_json TEXT,
      rows_copied INTEGER NOT NULL DEFAULT 0,
      last_batch_rows INTEGER NOT NULL DEFAULT 0,
      last_source_checksum TEXT,
      last_target_checksum TEXT,
      error_code TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(domain, table_name)
    );
    CREATE TABLE data_domain_parity_checks(
      check_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      table_name TEXT NOT NULL,
      check_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      source_count INTEGER,
      target_count INTEGER,
      source_checksum TEXT,
      target_checksum TEXT,
      evidence_json TEXT,
      checked_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

function seedAuthoritativeReceipt(
  db: SqliteD1,
  table: 'model_artifact_registry' | 'model_champion_pointers',
  rows: number,
  checksum: string,
): void {
  db.raw.prepare(`
    INSERT INTO data_domain_backfill_cursors(
      domain, table_name, status, cursor_json, rows_copied, last_batch_rows,
      last_source_checksum, last_target_checksum, error_code
    ) VALUES ('learning', ?, 'complete', NULL, ?, 0, ?, ?, NULL)
  `).run(table, rows, checksum, checksum)
  db.raw.prepare(`
    INSERT INTO data_domain_parity_checks(
      check_id, domain, table_name, check_kind, status, source_count, target_count,
      source_checksum, target_checksum, evidence_json
    ) VALUES (?, 'learning', ?, 'full_table', 'pass', ?, ?, ?, ?, ?)
  `).run(
    `domain-parity:learning:${table}:full-table`,
    table,
    rows,
    rows,
    checksum,
    checksum,
    JSON.stringify({
      schema_version: 'data-domain-shadow-full-table-v2',
      parity_scope: 'resumable_full_table_manifest',
      manifest_schema_version: 'rolling-page-sha256-v1',
      manifest_page_limit: 25,
    }),
  )
}

test('FK ancestor side-write blocks the parent and dependent pointer receipts', async () => {
  const source = new SqliteD1()
  const target = new SqliteD1()
  try {
    installLearningArtifactTables(source)
    installLearningArtifactTables(target)
    installControlPlane(source)
    source.raw.prepare(`
      INSERT INTO data_domain_cutovers(domain, status, source_binding, target_binding)
      VALUES ('learning', 'legacy', 'DB', 'LEARNING_DB')
    `).run()

    const artifactId = 'opaque-fusion-baseline'
    const owner = 'allocator_ev_fusion'
    const version = 'v1'
    const cohort = 'baseline:v1'
    const contract = 'fusion-contract-v1'
    const path = 'r2://expected-return/fusion/v1.json'
    const artifactJson = JSON.stringify({
      expected_return_owner: owner,
      model_version: version,
      serving_mode: 'abstention_baseline',
      promotion_state: 'safe_abstention',
      output_is_net_of_costs: true,
      primary_expected_return_allowed: false,
      artifact_contract_version: contract,
      validation_packet: { decision: 'PASS', alpha_quality_passed: false },
    })
    const checksum = await checksumText(artifactJson)
    const registryValues = [
      artifactId, owner, version, 'archived', path, cohort, contract, checksum, '{}',
    ]
    source.raw.prepare(`
      INSERT INTO model_artifact_registry(
        artifact_id, model_name, version, state, artifact_path, training_run_id,
        feature_policy_version, checksum, offline_evidence_json, marker
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new-parent-bytes')
    `).run(...registryValues)
    target.raw.prepare(`
      INSERT INTO model_artifact_registry(
        artifact_id, model_name, version, state, artifact_path, training_run_id,
        feature_policy_version, checksum, offline_evidence_json, marker
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'old-parent-bytes')
    `).run(...registryValues)
    source.raw.prepare(`
      INSERT INTO expected_return_artifact_payloads(
        artifact_id, model_name, model_version, serving_mode, artifact_json,
        payload_checksum, source_artifact_path, source_artifact_checksum,
        source_cohort_id, marker
      ) VALUES (?, ?, ?, 'abstention_baseline', ?, ?, ?, ?, ?, 'new-child-bytes')
    `).run(artifactId, owner, version, artifactJson, checksum, path, checksum, cohort)

    seedAuthoritativeReceipt(source, 'model_artifact_registry', 1, 'a'.repeat(64))
    seedAuthoritativeReceipt(source, 'model_champion_pointers', 0, 'b'.repeat(64))

    const result = await backfillDataDomainTableShadow({
      DB: source as unknown as D1Database,
      LEARNING_DB: target as unknown as D1Database,
      MULTI_D1_ACTIVE_DOMAINS: '',
      MULTI_D1_STRICT: 'false',
    } as Bindings, {
      domain: 'learning',
      table: 'expected_return_artifact_payloads',
    })

    assert.equal(result.status, 'shadow_progress')
    assert.deepEqual(
      { ...target.raw.prepare('SELECT artifact_id, marker FROM model_artifact_registry').get() },
      { artifact_id: artifactId, marker: 'new-parent-bytes' },
    )
    assert.deepEqual(
      { ...target.raw.prepare('SELECT artifact_id, marker FROM expected_return_artifact_payloads').get() },
      { artifact_id: artifactId, marker: 'new-child-bytes' },
    )
    const receiptStatuses = source.raw.prepare(`
      SELECT table_name, status
        FROM data_domain_parity_checks
       WHERE domain='learning' AND check_kind='full_table'
         AND table_name IN ('model_artifact_registry', 'model_champion_pointers')
       ORDER BY table_name
    `).all().map((row) => ({ ...row }))
    assert.deepEqual(receiptStatuses, [
      { table_name: 'model_artifact_registry', status: 'blocked' },
      { table_name: 'model_champion_pointers', status: 'blocked' },
    ])
    const payloadPageReads = [...source.observations, ...target.observations]
      .filter(({ sql }) => (
        /FROM\s+"expected_return_artifact_payloads"/i.test(sql)
        && /ORDER BY[\s\S]+LIMIT\s+\?/i.test(sql)
      ))
    assert(payloadPageReads.length >= 2)
    assert(payloadPageReads.every(({ values }) => Number(values.at(-1)) <= 25))
  } finally {
    source.raw.close()
    target.raw.close()
  }
})
