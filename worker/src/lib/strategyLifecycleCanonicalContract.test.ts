import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  canonicalStrategyLifecycleStatus,
  type StrategySpecStatus,
} from './strategySpec'

const cases: Array<[StrategySpecStatus, 'candidate' | 'active' | 'retired']> = [
  ['active', 'active'],
  ['candidate', 'candidate'],
  ['shadow', 'candidate'],
  ['research', 'candidate'],
  ['retired', 'retired'],
]
for (const [input, expected] of cases) {
  assert.equal(canonicalStrategyLifecycleStatus(input), expected)
}

const migration = fs.readFileSync(
  path.join(process.cwd(), 'migrations', '0120_strategy_lifecycle_candidate_active.sql'),
  'utf8',
)
assert.match(migration, /status IN \('shadow', 'research'\)/)
assert.match(migration, /SET status = 'candidate'/)
assert.match(migration, /promotion_status = 'candidate'/)
assert.doesNotMatch(migration, /DELETE|DROP/i)

const edge = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'strategyMarginalEdgeV4.ts'), 'utf8')
assert.doesNotMatch(edge, /strategy_status IN \('active', 'candidate', 'shadow'\)/)
assert.doesNotMatch(edge, /status IN \('shadow','candidate'\)/)

console.log('strategyLifecycleCanonicalContract: OK')
