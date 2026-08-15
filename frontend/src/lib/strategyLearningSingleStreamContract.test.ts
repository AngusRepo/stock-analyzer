import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync('src/pages/StrategyLearningPage.tsx', 'utf8')
const api = fs.readFileSync('src/lib/api.ts', 'utf8')
const worker = fs.readFileSync('../worker/src/lib/strategyLearning.ts', 'utf8')

assert.match(api, /allocation_eligible: boolean/)
assert.match(api, /active_retention_min_hit_rate: number/)
assert.match(worker, /PROMOTION_MIN_HIT_RATE = 0\.52/)
assert.match(worker, /ACTIVE_RETENTION_MIN_HIT_RATE = 0\.48/)
assert.match(page, /Active specs/)
assert.match(page, /Execution eligible/)
assert.match(page, /Single recommendation stream/)
assert.match(page, /52% \/ 48%/)
assert.match(page, /Atomic V7 replacement thresholds/)
assert.match(page, /gate\.allocation_eligible === true/)
assert.match(page, /0% allocation 仍持續學習/)
assert.doesNotMatch(page, /latest V6 run/)

console.log('strategy learning single-stream UI contract tests passed')
