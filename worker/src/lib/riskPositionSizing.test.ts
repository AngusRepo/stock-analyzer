import assert from 'node:assert/strict'
import { resolveCircuitAdjustedSingleNameCap } from './riskPositionSizing'

assert.equal(resolveCircuitAdjustedSingleNameCap({
  configuredSingleNameCap: 0.25,
  circuitBaselinePositionPct: 0.08,
  circuitEffectivePositionPct: 0.08,
}), 0.25, 'healthy circuit state must preserve the five-slot single-name cap')

assert.equal(resolveCircuitAdjustedSingleNameCap({
  configuredSingleNameCap: 0.25,
  circuitBaselinePositionPct: 0.08,
  circuitEffectivePositionPct: 0.04,
}), 0.125, 'high-vol 4% gauge must mean a 0.5x scale, not an absolute 4% NAV cap')

assert.equal(resolveCircuitAdjustedSingleNameCap({
  configuredSingleNameCap: 0.25,
  circuitBaselinePositionPct: 0.08,
  circuitEffectivePositionPct: 0.02,
}), 0.0625, 'red risk must preserve the strictest circuit scale')

assert.equal(resolveCircuitAdjustedSingleNameCap({
  configuredSingleNameCap: 0.25,
  circuitBaselinePositionPct: 0.08,
  circuitEffectivePositionPct: 0,
}), 0, 'halt must zero the final single-name cap')

console.log('risk position sizing tests passed')
