import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  dataDomainControlRevisionTriggerStatements,
  dataDomainControlRevisionBlockers,
  dataDomainControlRevisionEvidence,
  installDataDomainControlRevisionTriggers,
  loadDataDomainControlRevisionPair,
  strictDataDomainControlRevision,
} from './dataDomainControlRevision'
import { DATA_DOMAIN_CONTROL_TABLES } from './dataDomainShadowManifest'

function revisionDb(revisions: Record<string, number | string | null>): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => {
          assert(sql.includes('data_domain_control_revisions'))
          const revision = revisions[String(binds[0])]
          return revision === undefined ? null : { revision }
        },
      }),
    }),
  } as unknown as D1Database
}

function sqliteD1(db: DatabaseSync): D1Database {
  return {
    exec: async (sql: string) => {
      db.exec(sql)
      return { count: 1, duration: 0 }
    },
    prepare: (sql: string) => {
      let values: unknown[] = []
      const statement = {
        bind: (...binds: unknown[]) => {
          values = binds
          return statement
        },
        run: async () => {
          db.prepare(sql).run(...values as any[])
          return { success: true }
        },
        all: async <T>() => ({
          results: db.prepare(sql).all(...values as any[]) as T[],
        }),
      }
      return statement
    },
  } as unknown as D1Database
}

async function verifyMigration(relativePath: string): Promise<void> {
  const db = new DatabaseSync(':memory:')
  try {
    for (const table of DATA_DOMAIN_CONTROL_TABLES) {
      db.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, value TEXT)`)
    }
    const workerRoot = new URL('../../', import.meta.url)
    const migrationSql = readFileSync(new URL(relativePath, workerRoot), 'utf8')
    assert.doesNotMatch(migrationSql.replace(/^--.*$/gm, ''), /CREATE\s+TRIGGER/i)
    db.exec(migrationSql)
    const installed = await installDataDomainControlRevisionTriggers(sqliteD1(db))
    assert.equal(installed.revisionRows, 4)
    assert.equal(installed.triggerCount, 12)
    assert.deepEqual(installed.triggerNames, [...installed.triggerNames].sort())
    for (const table of DATA_DOMAIN_CONTROL_TABLES) {
      const initial = db.prepare(
        'SELECT revision FROM data_domain_control_revisions WHERE table_name=?',
      ).get(table) as { revision: number }
      assert.equal(initial.revision, 0)
      db.exec(`INSERT INTO "${table}"(id,value) VALUES (1,'a')`)
      db.exec(`UPDATE "${table}" SET value='b' WHERE id=1`)
      db.exec(`DELETE FROM "${table}" WHERE id=1`)
      const final = db.prepare(
        'SELECT revision FROM data_domain_control_revisions WHERE table_name=?',
      ).get(table) as { revision: number }
      assert.equal(final.revision, 3)
    }
  } finally {
    db.close()
  }
}

void (async () => {
  assert.equal(strictDataDomainControlRevision(0), 0)
  assert.equal(strictDataDomainControlRevision('12'), 12)
  assert.equal(strictDataDomainControlRevision('01'), null)
  assert.equal(strictDataDomainControlRevision(-1), null)
  assert.equal(strictDataDomainControlRevision(Number.MAX_SAFE_INTEGER + 1), null)
  assert.equal(dataDomainControlRevisionTriggerStatements().length, 12)
  const workerRoot = new URL('../../', import.meta.url)
  const adminTaskSource = readFileSync(
    new URL('src/lib/adminTriggerWorkerDomainTasks.ts', workerRoot),
    'utf8',
  )
  const adminRouteSource = readFileSync(
    new URL('src/routes/adminTriggerRoutes.ts', workerRoot),
    'utf8',
  )
  assert.match(adminTaskSource, /X-Confirm-Data-Domain-Control-Revision/)
  assert.match(adminTaskSource, /shadowDatabaseForDataDomain\(c\.env, 'learning'\)/)
  assert.match(adminTaskSource, /installDataDomainControlRevisionTriggers\(c\.env\.DB\)/)
  assert.match(adminTaskSource, /installDataDomainControlRevisionTriggers\(learningDb\)/)
  assert.match(adminRouteSource, /'data-domain-control-revision-trigger-install'/)

  const live = await loadDataDomainControlRevisionPair(
    revisionDb({ model_artifact_registry: 7 }),
    revisionDb({ model_artifact_registry: 11 }),
    'model_artifact_registry',
  )
  assert.deepEqual(live, { sourceRevision: 7, targetRevision: 11 })
  const receipt = {
    evidence_json: JSON.stringify(dataDomainControlRevisionEvidence(live)),
  }
  assert.deepEqual(dataDomainControlRevisionBlockers({ receipt, live }), [])
  assert.deepEqual(dataDomainControlRevisionBlockers({
    receipt,
    live: { sourceRevision: 8, targetRevision: 12 },
  }), [
    'source_revision_stale:7/8',
    'target_revision_stale:11/12',
  ])
  assert.deepEqual(dataDomainControlRevisionBlockers({
    receipt: { evidence_json: '{}' },
    live,
  }), ['revision_evidence_missing_or_invalid'])
  await assert.rejects(
    loadDataDomainControlRevisionPair(
      revisionDb({}),
      revisionDb({ model_artifact_registry: 0 }),
      'model_artifact_registry',
    ),
    /data_domain_control_revision_missing:model_artifact_registry/,
  )

  await verifyMigration('migrations/0108_data_domain_control_revision_fence.sql')
  await verifyMigration('domain-migrations/learning/0006_data_domain_control_revision_fence.sql')
  console.log('data domain control revision tests passed')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
