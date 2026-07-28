import assert from 'node:assert/strict'
import { isTransientD1Reset, withD1ReadRetry } from './d1TransientRetry'

async function main() {

assert.equal(
  isTransientD1Reset(new Error('D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset')),
  true,
)
assert.equal(isTransientD1Reset(new Error('UNIQUE constraint failed')), false)

let attempts = 0
const recovered = await withD1ReadRetry('snapshot', 'pending_buy_state', async () => {
  attempts += 1
  if (attempts === 1) throw new Error('D1_ERROR: object was reset')
  return 'ok'
}, 2)
assert.equal(recovered, 'ok')
assert.equal(attempts, 2)

await assert.rejects(
  () => withD1ReadRetry('positions', 'paper_positions', async () => {
    throw new Error('D1_ERROR: CPU time limit exceeded; object was reset')
  }, 1),
  (error: unknown) => {
    assert.match(String(error), /d1_stage=positions/)
    assert.match(String(error), /query_family=paper_positions/)
    return true
  },
)

let deterministicAttempts = 0
await assert.rejects(
  () => withD1ReadRetry('orders', 'paper_orders', async () => {
    deterministicAttempts += 1
    throw new Error('UNIQUE constraint failed')
  }, 2),
  (error: unknown) => {
    assert.match(String(error), /d1_stage=orders/)
    assert.equal(deterministicAttempts, 1)
    return true
  },
)

console.log('d1TransientRetry tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
