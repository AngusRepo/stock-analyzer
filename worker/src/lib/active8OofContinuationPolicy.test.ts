import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ACTIVE8_OOF_CONTINUATION_MAX_ATTEMPTS, active8OofContinuationDelay } from './active8OofContinuationPolicy'
assert.deepEqual([1, 2, 3, 4, 12, 13, 64].map(active8OofContinuationDelay), [300, 600, 1200, 1800, 1800, 1800, 1800])
for (const value of [0, -1, 1.5, 65, NaN]) assert.throws(() => active8OofContinuationDelay(value))
const total = Array.from({ length: ACTIVE8_OOF_CONTINUATION_MAX_ATTEMPTS }, (_, i) => active8OofContinuationDelay(i + 1)).reduce((a, b) => a + b, 0)
assert(total > (8 + 8 + 5) * 3600 && total < 32 * 3600)
const python = readFileSync(new URL('../../../ml-controller/services/oof_continuation.py', import.meta.url), 'utf8')
assert(python.includes(`COMPUTE_WAIT_MAX_ATTEMPTS = ${ACTIVE8_OOF_CONTINUATION_MAX_ATTEMPTS}`))
assert(python.includes('FAILURE_MAX_ATTEMPTS = 12'))
console.log('bounded OOF compute wait and backoff policy passed')
