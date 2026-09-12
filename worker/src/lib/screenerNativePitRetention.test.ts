import assert from 'node:assert/strict'
import { selectScreenerFunnelItemsForPersistence } from './marketScreener'
const rows = (stage: string, count: number) => Array.from({length: count}, (_, i) => ({symbol: `${stage}-${i}`, stage, decision:'pass', reasonCode:'test'} as any))
const seed=rows('l1_candidate_seed_after_overlay', 1500)
const scoring=rows('scoring', 2000)
const queue=rows('l15_ml_slate_queue', 2000)
const result=selectScreenerFunnelItemsForPersistence([...rows('universe', 3000),...scoring,...seed,...queue])
assert.equal(result.length, 5500)
assert.equal(result.filter(r=>r.stage==='scoring').length, 2000)
assert.equal(result.filter(r=>r.stage==='l1_candidate_seed_after_overlay').length,1500)
assert.equal(result.filter(r=>r.stage==='universe').length,0)
assert.equal(selectScreenerFunnelItemsForPersistence([...rows('universe',6000),...scoring]).length,5000)
console.log('native PIT retention beyond soft cap: PASS')
