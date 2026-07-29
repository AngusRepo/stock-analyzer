import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'src/lib/strategyLearning.ts'), 'utf8')

assert(source.includes('round6(lifetimeHits / lifetimeSamples)'), 'lifetime hit rate must divide contract-valid hits by samples')
assert(source.includes('round6(lifetimeRewardSum / lifetimeSamples)'), 'lifetime return must divide contract-valid reward sum by samples')
assert(source.includes('round6(rollingHits / rollingSamples)'), 'rolling hit rate must divide contract-valid hits by samples')
assert(source.includes('round6(rollingRewardSum / rollingSamples)'), 'rolling return must divide contract-valid reward sum by samples')

console.log('strategyLearningRewardAggregationContract.test.ts: PASS')
