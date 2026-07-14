import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'src/lib/strategyLearning.ts'), 'utf8')

assert(source.includes('SUM(hit_rate * samples)'), 'strategy learning hit rate must be sample-weighted')
assert(source.includes('SUM(avg_return_pct * samples)'), 'strategy learning average return must be sample-weighted')
assert(!source.includes('AVG(hit_rate) AS hit_rate'), 'unweighted hit-rate aggregation must not return')
assert(!source.includes('AVG(avg_return_pct) AS avg_return_pct'), 'unweighted return aggregation must not return')

console.log('strategyLearningRewardAggregationContract.test.ts: PASS')
