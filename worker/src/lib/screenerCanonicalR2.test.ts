import assert from 'node:assert/strict'
import fs from 'node:fs'

const screener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const continuation = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')

assert.match(screener, /writeEvidenceArtifact\(env/)
assert.match(screener, /screener_r2_artifact_binding_missing/)
assert.match(screener, /registerPipelineRun/)
assert.match(screener, /registry\.status === 'reused'/)
assert.match(screener, /promoteCanonicalRun/)
assert.match(screener, /status='ready', artifact_id=/)
assert.match(continuation, /canonical_run_heads/)
assert.match(continuation, /p\.status = 'canonical'/)

console.log('screener canonical R2 contract tests passed')
