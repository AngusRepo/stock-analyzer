import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { installDataDomainControlRevisionTriggers } from './dataDomainControlRevision'

test('0045 preserves exact existing identities/data and restores revision fences before OPB registration', async (t) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('PRAGMA foreign_keys=ON')
  const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
  const previous = readFileSync('domain-migrations/learning/0010_expected_return_candidate_registry_identity_v3.sql', 'utf8')
  const tables = ['model_artifact_registry', 'expected_return_artifact_payloads', 'model_champion_pointers', 'model_champion_history']
  for (const table of tables) {
    const source = table === 'model_artifact_registry' ? previous : schema
    const statement = source.match(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table} \\([\\s\\S]*?\\n\\);`))?.[0]
    assert(statement)
    db.exec(statement)
  }
  for (const statement of schema.matchAll(/CREATE INDEX IF NOT EXISTS\s+\w+\s+ON\s+(model_artifact_registry|expected_return_artifact_payloads)\([\s\S]*?;/g)) db.exec(statement[0])
  db.exec(readFileSync('domain-migrations/learning/0006_data_domain_control_revision_fence.sql', 'utf8'))
  const d1 = { prepare(sql: string) {
    let params: any[] = []
    return { bind(...values: any[]) { params = values; return this },
      async run() { db.prepare(sql).run(...params); return { success: true } },
      async all() { return { results: db.prepare(sql).all(...params) } } }
  } } as unknown as D1Database
  assert.equal((await installDataDomainControlRevisionTriggers(d1)).triggerCount, 12)
  for (const [owner, state] of [['l4_alpha_ev', 'production'], ['allocator_ev_fusion', 'archived']]) {
    db.prepare('INSERT INTO model_artifact_registry (artifact_id,model_name,version,candidate_type,state,checksum) VALUES (?,?,?,?,?,?)')
      .run(owner, owner, 'original', `${owner}_refresh`, state, 'a'.repeat(64))
    db.prepare('INSERT INTO expected_return_artifact_payloads (artifact_id,model_name,model_version,serving_mode,artifact_json,payload_checksum) VALUES (?,?,?,?,?,?)')
      .run(owner, owner, 'original', 'alpha', '{"original":true}', 'b'.repeat(64))
    db.prepare('INSERT INTO model_champion_pointers (model_name,champion_version,champion_artifact_id,promotion_evidence_json) VALUES (?,?,?,?)')
      .run(owner, 'original', owner, '{"sealed":"untouched"}')
    db.prepare('INSERT INTO model_champion_history (event_id,model_name,version,artifact_id,effective_at,source,evidence_grade,evidence_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(owner, owner, 'original', owner, '2026-09-01', 'model_champion_history', 'exact', '{"sealed":"original"}')
  }
  const register = (kind: string) => db.prepare('INSERT INTO model_artifact_registry (artifact_id,model_name,version,candidate_type,state) VALUES (?,?,?,?,?)')
    .run(kind, 'opb_arm_prior', 'fixture', kind, 'offline_passed')
  assert.throws(() => register('opb_arm_prior_refresh'), /CHECK constraint/)
  const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]))
  const revisions = db.prepare('SELECT * FROM data_domain_control_revisions ORDER BY 1').all()
  db.exec('BEGIN')
  try {
    db.exec(readFileSync('domain-migrations/learning/0045_opb_artifact_registry_type.sql', 'utf8'))
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  for (const table of tables) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), before[table])
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get()?.n, 6)
  // Actual required post-migration step, not a mocked successful ACK.
  assert.equal((await installDataDomainControlRevisionTriggers(d1)).triggerCount, 12)
  const after = db.prepare('SELECT * FROM data_domain_control_revisions ORDER BY 1').all()
  after.forEach((row, i) => assert.equal(row.revision, Number(revisions[i].revision)
    + (['model_artifact_registry', 'expected_return_artifact_payloads'].includes(String(row.table_name)) ? 1 : 0)))
  register('opb_arm_prior_refresh')
  assert.throws(() => register('invented_candidate_type'), /CHECK constraint/)
  const revision = () => Number(db.prepare("SELECT revision FROM data_domain_control_revisions WHERE table_name='model_artifact_registry'").get()?.revision)
  const inserted = revision()
  db.prepare("UPDATE model_artifact_registry SET state='shadowing' WHERE artifact_id='opb_arm_prior_refresh'").run()
  assert.equal(revision(), inserted + 1)
  db.prepare("DELETE FROM model_artifact_registry WHERE artifact_id='opb_arm_prior_refresh'").run()
  assert.equal(revision(), inserted + 2)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('schema regeneration retains OPB enum without changing immutable baseline migrations', () => {
  const generator = readFileSync('scripts/build-domain-schemas.mjs', 'utf8')
  const body = generator.match(/function normalizeCreate\(statement\) \{([\s\S]*?)\n\}/)?.[1]
  assert(body)
  const normalize = new Function('statement', body) as (statement: string) => string
  const baseline = readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
    .match(/CREATE TABLE IF NOT EXISTS model_artifact_registry \([\s\S]*?\n\);/)?.[0]
  assert(baseline && !baseline.includes("'opb_arm_prior_refresh'"))
  const once = normalize(baseline)
  assert.equal(once.match(/'opb_arm_prior_refresh'/g)?.length, 1)
  assert.equal(normalize(once), once)
  assert.throws(() => normalize('CREATE TABLE model_artifact_registry (unrecognized TEXT);'), /anchor_missing/)
})
