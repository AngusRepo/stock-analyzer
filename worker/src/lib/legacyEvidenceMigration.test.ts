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
assert.match(scheduler, /"id": "legacy-evidence-migration"/)
assert.match(scheduler, /limit=100&max_chunks=1/)

console.log('legacy evidence migration contract tests passed')
