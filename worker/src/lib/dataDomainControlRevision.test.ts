import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  dataDomainControlRevisionBlockers,
  dataDomainControlRevisionEvidence,
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

function verifyMigration(relativePath: string): void {
  const db = new DatabaseSync(':memory:')
  try {
    for (const table of DATA_DOMAIN_CONTROL_TABLES) {
      db.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, value TEXT)`)
    }
    const workerRoot = new URL('../../', import.meta.url)
    db.exec(readFileSync(new URL(relativePath, workerRoot), 'utf8'))
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

  verifyMigration('migrations/0108_data_domain_control_revision_fence.sql')
  verifyMigration('domain-migrations/learning/0006_data_domain_control_revision_fence.sql')
  console.log('data domain control revision tests passed')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
