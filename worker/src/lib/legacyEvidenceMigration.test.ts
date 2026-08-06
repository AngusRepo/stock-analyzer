import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync('src/lib/legacyEvidenceMigration.ts', 'utf8')
const scheduler = fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')

assert.match(migration, /writeEvidenceArtifact/)
assert.match(migration, /NOT EXISTS \(\s*SELECT 1 FROM canonical_run_heads/)
assert.match(migration, /latest\.status = 'success'/)
assert.match(migration, /artifact_d1_scrub_queue/)
assert.match(migration, /INSERT OR IGNORE/)
assert.match(migration, /retentionClass: 'superseded_run'/)
assert.match(migration, /cursor\?\.status === 'complete'/)
assert.ok(
  migration.indexOf("cursor?.status === 'complete'") < migration.indexOf('SELECT sfi.id'),
  'completed migration must return before scanning screener_funnel_items',
)
assert.match(scheduler, /"id": "legacy-evidence-migration"/)
assert.match(scheduler, /limit=500&max_chunks=5/)

console.log('legacy evidence migration contract tests passed')
