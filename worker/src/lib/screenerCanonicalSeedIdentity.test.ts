import assert from 'node:assert/strict'
import { assertCanonicalL15SeedIdentity } from './marketScreener'

assert.doesNotThrow(() => assertCanonicalL15SeedIdentity({
  routeSymbols: ['2330', '2317'],
  finalSymbols: ['2330', '2317'],
}))

assert.doesNotThrow(() => assertCanonicalL15SeedIdentity({
  routeSymbols: ['2330', '2317'],
  finalSymbols: ['2330'],
  safetyExcludedSymbols: ['2317'],
}))

assert.throws(
  () => assertCanonicalL15SeedIdentity({
    routeSymbols: ['2330', '2317'],
    finalSymbols: ['2330'],
  }),
  /unexplained_exclusion=2317/,
)

assert.throws(
  () => assertCanonicalL15SeedIdentity({
    routeSymbols: ['2330'],
    finalSymbols: ['2330', '2317'],
  }),
  /missing_route=2317/,
)

assert.throws(
  () => assertCanonicalL15SeedIdentity({
    routeSymbols: ['2330', '2317'],
    finalSymbols: ['2330'],
    safetyExcludedSymbols: ['2330'],
  }),
  /unexplained_exclusion=2317:invalid_safety_receipt=2330/,
)

console.log('screener canonical seed identity tests passed')
