import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

const workerRoot = new URL('../../', import.meta.url)
const lanes = [
  { name: 'legacy', migrationPath: 'migrations/0112_expected_return_candidate_registry_identity_v3.sql' },
  { name: 'learning', migrationPath: 'domain-migrations/learning/0010_expected_return_candidate_registry_identity_v3.sql' },
] as const

const controlTables = [
  'model_artifact_registry',
  'expected_return_artifact_payloads',
  'model_champion_history',
  'model_champion_pointers',
] as const
type ControlTable = (typeof controlTables)[number]

const rebuiltTables = [
  'model_artifact_registry',
  'expected_return_artifact_payloads',
] as const
type RebuiltTable = (typeof rebuiltTables)[number]

function revisionTriggerName(
  tableName: ControlTable,
  operation: 'insert' | 'update' | 'delete',
): string {
  return `trg_${tableName}_revision_${operation}`
}

// Models the deployed schema after legacy 0108+0109 or Learning 0006+0007.
function installRevisionFence(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE data_domain_control_revisions (
      table_name TEXT PRIMARY KEY CHECK(table_name IN (
        'model_artifact_registry',
        'expected_return_artifact_payloads',
        'model_champion_history',
        'model_champion_pointers'
      )),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO data_domain_control_revisions(table_name, revision)
    VALUES
      ('model_artifact_registry', 7),
      ('expected_return_artifact_payloads', 11),
      ('model_champion_history', 13),
      ('model_champion_pointers', 17);
  `)
  for (const tableName of controlTables) {
    for (const operation of ['insert', 'update', 'delete'] as const) {
      db.exec(`
        CREATE TRIGGER ${revisionTriggerName(tableName, operation)}
        AFTER ${operation.toUpperCase()} ON ${tableName}
        BEGIN
          INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
          VALUES ('${tableName}', 1, CURRENT_TIMESTAMP)
          ON CONFLICT(table_name) DO UPDATE SET
            revision=revision + 1,
            updated_at=CURRENT_TIMESTAMP;
        END;
      `)
    }
  }
}

function installPreMigrationSchema(
  db: DatabaseSync,
  options: { includeNullArtifactId?: boolean } = {},
): void {
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE model_artifact_registry (
      artifact_id TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      version TEXT NOT NULL,
      candidate_type TEXT NOT NULL CHECK(candidate_type IN (
        'monthly_release','weekly_drift','oof_full_fit_release','manual_hotfix',
        'model_family_shadow','research_benchmark',
        'timesfm_l175_l2_feature_release','l4_alpha_ev_refresh',
        'allocator_ev_fusion_refresh','unknown'
      )),
      state TEXT NOT NULL CHECK(state IN (
        'registered','registration_failed','offline_failed','offline_passed_weak',
        'offline_passed','offline_strong_pass','candidate_selected','shadowing',
        'live_gate_passed','approval_required','approved','production','rejected',
        'archived'
      )),
      artifact_path TEXT,
      metadata_path TEXT,
      training_run_id TEXT,
      training_manifest_path TEXT,
      trained_from_snapshot TEXT,
      evaluation_baseline_version TEXT,
      final_compared_to TEXT,
      feature_policy_version TEXT,
      checksum TEXT,
      source_run_date TEXT,
      is_monthly INTEGER NOT NULL DEFAULT 0,
      offline_gate_status TEXT NOT NULL DEFAULT 'not_evaluated',
      offline_gate_decision TEXT NOT NULL DEFAULT 'PENDING',
      offline_gate_failed_gates TEXT NOT NULL DEFAULT '[]',
      offline_evidence_json TEXT NOT NULL DEFAULT '{}',
      live_gate_status TEXT NOT NULL DEFAULT 'not_started',
      live_evidence_json TEXT NOT NULL DEFAULT '{}',
      promotion_decision TEXT NOT NULL DEFAULT 'not_evaluated',
      approval_state TEXT NOT NULL DEFAULT 'not_required',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(model_name, version, candidate_type)
    );
    CREATE INDEX idx_model_artifact_registry_model_state
      ON model_artifact_registry(model_name, state, updated_at DESC);
    CREATE INDEX idx_model_artifact_registry_candidate_type
      ON model_artifact_registry(candidate_type, state, updated_at DESC);
    CREATE INDEX idx_model_artifact_registry_run
      ON model_artifact_registry(training_run_id, source_run_date);

    CREATE TABLE model_champion_history (
      event_id TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      version TEXT NOT NULL,
      artifact_id TEXT,
      effective_at TEXT NOT NULL,
      retired_at TEXT,
      source TEXT NOT NULL CHECK(source = 'model_champion_history'),
      evidence_grade TEXT NOT NULL CHECK(evidence_grade IN ('exact','bounded','unknown')),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(model_name, version, effective_at)
    );
    CREATE INDEX idx_model_champion_history_asof
      ON model_champion_history(model_name, effective_at, retired_at);
    CREATE INDEX idx_model_champion_history_semantic_scan
      ON model_champion_history(model_name, effective_at, event_id);

    CREATE TABLE model_champion_pointers (
      model_name TEXT PRIMARY KEY,
      champion_version TEXT NOT NULL,
      champion_artifact_id TEXT,
      rollback_version TEXT,
      rollback_artifact_id TEXT,
      promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      promotion_reason TEXT,
      promotion_evidence_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_model_champion_pointers_updated
      ON model_champion_pointers(updated_at DESC);

    CREATE TABLE expected_return_artifact_payloads (
      artifact_id TEXT PRIMARY KEY,
      model_name TEXT NOT NULL CHECK(model_name IN ('l4_alpha_ev','allocator_ev_fusion')),
      model_version TEXT NOT NULL,
      serving_mode TEXT NOT NULL CHECK(serving_mode IN ('alpha','abstention_baseline')),
      artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
      payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64),
      source_artifact_path TEXT,
      source_artifact_checksum TEXT,
      source_cohort_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(artifact_id) REFERENCES model_artifact_registry(artifact_id) ON DELETE RESTRICT,
      UNIQUE(model_name, model_version)
    );
    CREATE INDEX idx_expected_return_artifact_payloads_owner
      ON expected_return_artifact_payloads(model_name, serving_mode, updated_at DESC);
  `)

  db.prepare(`
    INSERT INTO model_artifact_registry(
      artifact_id, model_name, version, candidate_type, state, artifact_path,
      metadata_path, training_run_id, training_manifest_path,
      trained_from_snapshot, evaluation_baseline_version, final_compared_to,
      feature_policy_version, checksum, source_run_date, is_monthly,
      offline_gate_status, offline_gate_decision, offline_gate_failed_gates,
      offline_evidence_json, live_gate_status, live_evidence_json,
      promotion_decision, approval_state, created_at, updated_at
    ) VALUES (
      ?, 'allocator_ev_fusion', 'fusion-v14', 'allocator_ev_fusion_refresh',
      'offline_failed', 'gs://artifacts/fusion-v14/old.json',
      'gs://artifacts/fusion-v14/old.metadata.json', 'run-old',
      'gs://manifests/run-old.json', 'snapshot-old', 'fusion-v13', 'fusion-v13',
      'feature-policy-v5', ?, '2026-08-09', 0, 'complete', 'FAIL',
      '["residual_spread_lcb90"]', '{"schema_version":"expected-return-candidate-identity-v2"}',
      'not_started', '{}', 'shadow_only', 'not_required',
      '2026-08-09 01:02:03', '2026-08-09 04:05:06'
    )
  `).run('candidate-old', 'a'.repeat(64))
  db.prepare(`
    INSERT INTO expected_return_artifact_payloads(
      artifact_id, model_name, model_version, serving_mode, artifact_json,
      payload_checksum, source_artifact_path, source_artifact_checksum,
      source_cohort_id, created_at, updated_at
    ) VALUES (
      'candidate-old', 'allocator_ev_fusion', 'fusion-v14',
      'abstention_baseline', '{"mode":"safe"}', ?,
      'gs://artifacts/fusion-v14/old.json', ?, 'cohort-old',
      '2026-08-09 01:02:03', '2026-08-09 04:05:06'
    )
  `).run('b'.repeat(64), 'a'.repeat(64))
  db.exec(`
    INSERT INTO model_champion_history(
      event_id, model_name, version, artifact_id, effective_at, retired_at,
      source, evidence_grade, evidence_json, created_at
    ) VALUES (
      'event-old', 'allocator_ev_fusion', 'fusion-v14', 'candidate-old',
      '2026-08-09 04:05:06', NULL, 'model_champion_history', 'exact',
      '{"reason":"baseline"}', '2026-08-09 04:05:06'
    );
    INSERT INTO model_champion_pointers(
      model_name, champion_version, champion_artifact_id, rollback_version,
      rollback_artifact_id, promoted_at, promotion_reason,
      promotion_evidence_json, updated_at
    ) VALUES (
      'allocator_ev_fusion', 'fusion-v14', 'candidate-old', 'fusion-v13',
      'allocator_ev_fusion:fusion-v13', '2026-08-09 04:05:06', 'baseline',
      '{"reason":"baseline"}', '2026-08-09 04:05:06'
    );
  `)

  if (options.includeNullArtifactId) {
    db.exec(`
      INSERT INTO model_artifact_registry(
        artifact_id, model_name, version, candidate_type, state
      ) VALUES (NULL, 'null_identity_probe', 'v1', 'unknown', 'registered');
    `)
  }
  installRevisionFence(db)
}

// Wrangler applies one D1 migration atomically. The SQL file itself must not BEGIN.
function applyLikeD1(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(sql)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function pragmaNumber(db: DatabaseSync, name: 'foreign_keys' | 'defer_foreign_keys'): number {
  return Number((db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name])
}

function orderedRows(db: DatabaseSync, tableName: ControlTable): Record<string, unknown>[] {
  const orderBy = tableName === 'model_artifact_registry'
    || tableName === 'expected_return_artifact_payloads'
    ? 'artifact_id'
    : tableName === 'model_champion_history' ? 'event_id' : 'model_name'
  return db.prepare(`SELECT * FROM ${tableName} ORDER BY ${orderBy}`).all()
    .map((row) => ({ ...row }))
}

function controlRows(db: DatabaseSync): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(controlTables.map((tableName) => [tableName, orderedRows(db, tableName)]))
}

function revisionRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`
    SELECT table_name, revision, updated_at
      FROM data_domain_control_revisions
     ORDER BY table_name
  `).all().map((row) => ({ ...row }))
}

function revisionMap(db: DatabaseSync): Map<string, number> {
  return new Map(db.prepare(`
    SELECT table_name, revision
      FROM data_domain_control_revisions
     ORDER BY table_name
  `).all().map((row) => [String(row.table_name), Number(row.revision)]))
}

function namedIndexes(db: DatabaseSync): string[] {
  return db.prepare(`
    SELECT name FROM sqlite_schema
     WHERE type='index' AND sql IS NOT NULL
       AND tbl_name IN (
         'model_artifact_registry','expected_return_artifact_payloads',
         'model_champion_history','model_champion_pointers'
       )
     ORDER BY name
  `).all().map((row) => String(row.name))
}

function revisionTriggers(db: DatabaseSync): Array<{ name: string; sql: string }> {
  return db.prepare(`
    SELECT name, sql FROM sqlite_schema
     WHERE type='trigger' AND name LIKE 'trg_%_revision_%'
     ORDER BY name
  `).all().map((row) => ({ name: String(row.name), sql: String(row.sql) }))
}

function schemaSnapshot(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
     WHERE name IN (
       'model_artifact_registry','expected_return_artifact_payloads',
       'model_champion_history','model_champion_pointers',
       'data_domain_control_revisions'
     ) OR tbl_name IN (
       'model_artifact_registry','expected_return_artifact_payloads',
       'model_champion_history','model_champion_pointers',
       'data_domain_control_revisions'
     )
     ORDER BY type, name
  `).all().map((row) => ({ ...row }))
}

function artifactIdNotNull(db: DatabaseSync, tableName: RebuiltTable): number {
  const row = db.prepare(`PRAGMA table_info('${tableName}')`).all()
    .find((column) => column.name === 'artifact_id')
  assert(row, `${tableName}.artifact_id missing`)
  return Number(row.notnull)
}

function uniqueIndexColumns(db: DatabaseSync, tableName: RebuiltTable): string[] {
  return db.prepare(`PRAGMA index_list('${tableName}')`).all()
    .filter((index) => Number(index.unique) === 1)
    .map((index) => db.prepare(`PRAGMA index_info('${String(index.name)}')`).all()
      .map((column) => String(column.name)).join(','))
    .sort()
}

function expectedRevisionTriggerNames(): string[] {
  return controlTables.flatMap((tableName) => (
    (['delete', 'insert', 'update'] as const)
      .map((operation) => revisionTriggerName(tableName, operation))
  )).sort()
}

function migrationSql(relativePath: string): string {
  return readFileSync(new URL(relativePath, workerRoot), 'utf8')
}

for (const lane of lanes) {
  test(`${lane.name}: preserves rows, FK/index parity, and revision values`, () => {
    const db = new DatabaseSync(':memory:')
    try {
      installPreMigrationSchema(db)
      const rowsBefore = controlRows(db)
      const revisionsBefore = revisionMap(db)
      const indexesBefore = namedIndexes(db)
      applyLikeD1(db, migrationSql(lane.migrationPath))

      assert.deepEqual(controlRows(db), rowsBefore)
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
      assert.equal(pragmaNumber(db, 'foreign_keys'), 1)
      assert.equal(pragmaNumber(db, 'defer_foreign_keys'), 0)
      assert.equal(artifactIdNotNull(db, 'model_artifact_registry'), 1)
      assert.equal(artifactIdNotNull(db, 'expected_return_artifact_payloads'), 1)

      const revisionsAfter = revisionMap(db)
      assert.equal(revisionsAfter.size, 4)
      for (const tableName of controlTables) {
        const expectedDelta = (rebuiltTables as readonly string[]).includes(tableName) ? 1 : 0
        assert.equal(
          revisionsAfter.get(tableName),
          Number(revisionsBefore.get(tableName)) + expectedDelta,
          `${tableName} revision delta`,
        )
      }
      assert.deepEqual(namedIndexes(db), [
        ...indexesBefore,
        'idx_expected_return_artifact_payloads_version',
        'idx_model_artifact_registry_identity_v3',
      ].sort())
      assert(namedIndexes(db).includes('idx_model_champion_history_semantic_scan'))
      assert.deepEqual(uniqueIndexColumns(db, 'model_artifact_registry'), ['artifact_id'])
      assert.deepEqual(uniqueIndexColumns(db, 'expected_return_artifact_payloads'), ['artifact_id'])
    } finally {
      db.close()
    }
  })

  test(`${lane.name}: keeps all twelve revision triggers self-healing`, () => {
    const db = new DatabaseSync(':memory:')
    try {
      installPreMigrationSchema(db)
      applyLikeD1(db, migrationSql(lane.migrationPath))
      const triggers = revisionTriggers(db)
      assert.deepEqual(triggers.map(({ name }) => name), expectedRevisionTriggerNames())
      for (const trigger of triggers) {
        assert.match(trigger.sql, /INSERT INTO data_domain_control_revisions/i, trigger.name)
        assert.match(trigger.sql, /ON CONFLICT\s*\(\s*table_name\s*\)\s*DO UPDATE SET/i, trigger.name)
      }

      db.exec(`DELETE FROM data_domain_control_revisions WHERE table_name='model_artifact_registry'`)
      db.prepare(`
        INSERT INTO model_artifact_registry(
          artifact_id, model_name, version, candidate_type, state, checksum
        ) VALUES (?, 'l4_alpha_ev', 'l4-v5', 'l4_alpha_ev_refresh', 'registered', ?)
      `).run('self-heal-registry', 'c'.repeat(64))
      assert.equal(revisionMap(db).get('model_artifact_registry'), 1)
      db.exec(`UPDATE model_artifact_registry SET state='offline_failed' WHERE artifact_id='self-heal-registry'`)
      assert.equal(revisionMap(db).get('model_artifact_registry'), 2)
      db.exec(`DELETE FROM model_artifact_registry WHERE artifact_id='self-heal-registry'`)
      assert.equal(revisionMap(db).get('model_artifact_registry'), 3)

      db.prepare(`
        INSERT INTO model_artifact_registry(
          artifact_id, model_name, version, candidate_type, state, checksum
        ) VALUES (?, 'l4_alpha_ev', 'l4-v6', 'l4_alpha_ev_refresh', 'registered', ?)
      `).run('self-heal-payload-parent', 'd'.repeat(64))
      db.exec(`DELETE FROM data_domain_control_revisions WHERE table_name='expected_return_artifact_payloads'`)
      db.prepare(`
        INSERT INTO expected_return_artifact_payloads(
          artifact_id, model_name, model_version, serving_mode, artifact_json, payload_checksum
        ) VALUES (?, 'l4_alpha_ev', 'l4-v6', 'alpha', '{}', ?)
      `).run('self-heal-payload-parent', 'e'.repeat(64))
      assert.equal(revisionMap(db).get('expected_return_artifact_payloads'), 1)
      db.exec(`UPDATE expected_return_artifact_payloads SET serving_mode='abstention_baseline'
                WHERE artifact_id='self-heal-payload-parent'`)
      assert.equal(revisionMap(db).get('expected_return_artifact_payloads'), 2)
      db.exec(`DELETE FROM expected_return_artifact_payloads WHERE artifact_id='self-heal-payload-parent'`)
      assert.equal(revisionMap(db).get('expected_return_artifact_payloads'), 3)
    } finally {
      db.close()
    }
  })

  test(`${lane.name}: enforces identity/FK while allowing checksum successors`, () => {
    const db = new DatabaseSync(':memory:')
    try {
      installPreMigrationSchema(db)
      applyLikeD1(db, migrationSql(lane.migrationPath))
      db.prepare(`
        INSERT INTO model_artifact_registry(
          artifact_id, model_name, version, candidate_type, state, checksum
        ) VALUES (?, 'allocator_ev_fusion', 'fusion-v14',
                  'allocator_ev_fusion_refresh', 'offline_passed', ?)
      `).run('candidate-new', 'f'.repeat(64))
      db.prepare(`
        INSERT INTO expected_return_artifact_payloads(
          artifact_id, model_name, model_version, serving_mode, artifact_json, payload_checksum
        ) VALUES (?, 'allocator_ev_fusion', 'fusion-v14', 'alpha', '{}', ?)
      `).run('candidate-new', '1'.repeat(64))
      assert.equal(db.prepare(`SELECT COUNT(*) count FROM model_artifact_registry
        WHERE model_name='allocator_ev_fusion' AND version='fusion-v14'
          AND candidate_type='allocator_ev_fusion_refresh'`).get()?.count, 2)
      assert.equal(db.prepare(`SELECT COUNT(*) count FROM expected_return_artifact_payloads
        WHERE model_name='allocator_ev_fusion' AND model_version='fusion-v14'`).get()?.count, 2)

      assert.throws(() => db.exec(`INSERT INTO model_artifact_registry(
        artifact_id, model_name, version, candidate_type, state
      ) VALUES (NULL, 'null-probe', 'v1', 'unknown', 'registered')`), /NOT NULL/)
      assert.throws(() => db.exec(`INSERT INTO model_artifact_registry(
        artifact_id, model_name, version, candidate_type, state
      ) VALUES ('   ', 'blank-probe', 'v1', 'unknown', 'registered')`), /CHECK/)
      assert.throws(() => db.exec(`INSERT INTO model_artifact_registry(
        artifact_id, model_name, version, candidate_type, state
      ) VALUES ('candidate-new', 'duplicate-probe', 'v1', 'unknown', 'registered')`), /UNIQUE/)
      assert.throws(() => db.prepare(`INSERT INTO expected_return_artifact_payloads(
        artifact_id, model_name, model_version, serving_mode, artifact_json, payload_checksum
      ) VALUES ('orphan', 'l4_alpha_ev', 'l4-v5', 'alpha', '{}', ?)`)
        .run('2'.repeat(64)), /FOREIGN KEY/)

      assert.deepEqual(
        db.prepare(`PRAGMA foreign_key_list('expected_return_artifact_payloads')`).all()
          .map((row) => ({
            table: row.table,
            from: row.from,
            to: row.to,
            on_update: row.on_update,
            on_delete: row.on_delete,
          })),
        [{
          table: 'model_artifact_registry',
          from: 'artifact_id',
          to: 'artifact_id',
          on_update: 'NO ACTION',
          on_delete: 'RESTRICT',
        }],
      )
      const rowsBeforeFailedDelete = controlRows(db)
      const revisionsBeforeFailedDelete = revisionRows(db)
      assert.throws(
        () => db.exec(`DELETE FROM model_artifact_registry WHERE artifact_id='candidate-new'`),
        /FOREIGN KEY/,
      )
      assert.deepEqual(controlRows(db), rowsBeforeFailedDelete)
      assert.deepEqual(revisionRows(db), revisionsBeforeFailedDelete)
    } finally {
      db.close()
    }
  })

  test(`${lane.name}: rolls back atomically on legacy NULL identity`, () => {
    const db = new DatabaseSync(':memory:')
    try {
      installPreMigrationSchema(db, { includeNullArtifactId: true })
      const schemaBefore = schemaSnapshot(db)
      const rowsBefore = controlRows(db)
      const revisionsBefore = revisionRows(db)
      assert.throws(() => applyLikeD1(db, migrationSql(lane.migrationPath)), /NOT NULL/)

      assert.deepEqual(schemaSnapshot(db), schemaBefore)
      assert.deepEqual(controlRows(db), rowsBefore)
      assert.deepEqual(revisionRows(db), revisionsBefore)
      assert.equal(artifactIdNotNull(db, 'model_artifact_registry'), 0)
      assert.equal(db.prepare(`SELECT COUNT(*) count FROM model_artifact_registry
        WHERE artifact_id IS NULL`).get()?.count, 1)
      assert.equal(db.prepare(`SELECT COUNT(*) count FROM sqlite_schema WHERE name IN (
        'model_artifact_registry_identity_v2_legacy',
        'expected_return_artifact_payloads_identity_v2_legacy'
      )`).get()?.count, 0)
      assert.equal(pragmaNumber(db, 'foreign_keys'), 1)
      assert.equal(pragmaNumber(db, 'defer_foreign_keys'), 0)
    } finally {
      db.close()
    }
  })
}

