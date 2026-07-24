import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('.')
const repair = fs.readFileSync(path.join(root, 'src/lib/selectionReferenceRepair.ts'), 'utf8')
const learning = fs.readFileSync(path.join(root, 'src/lib/strategyLearning.ts'), 'utf8')
const runState = fs.readFileSync(path.join(root, 'src/lib/strategyLearningRunState.ts'), 'utf8')

assert.match(repair, /pipeline_runs p[\s\S]*p\.status='canonical'/)
assert.match(repair, /ra\.schema_version IN \('screener-funnel-evidence-v2', 'screener-funnel-evidence-v3'\)/)
assert.match(repair, /ra\.checksum_verified_at IS NOT NULL/)
assert.match(repair, /score_v2_count/)
assert.match(repair, /coverageCounts\.some\(\(count\) => count !== expectedRows\)/)
assert.match(repair, /strategy_matrix_point_in_time_evidence_unavailable/)
assert.match(repair, /'historical_reconstruction', 'unavailable'/)
assert.match(learning, /r\.strategy_labeled=1[\s\S]*r\.strategy_matrix_status='ready'/)
assert.match(runState, /r\.strategy_labeled=1[\s\S]*r\.strategy_matrix_status='ready'/)

console.log('selection reference repair contract tests passed')