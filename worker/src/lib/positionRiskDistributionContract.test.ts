import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const entry = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
assert.match(entry, /getRiskConfig\(env\.KV\)/)
assert.match(entry, /riskCfg\.position\.maxPerSector/)
assert.match(entry, /riskCfg\.position\.maxSingleNamePct/)
assert.match(entry, /riskCfg\.position\.correlationWindow/)
assert.match(entry, /riskCfg\.position\.correlationThreshold/)
assert.match(entry, /assessPositionCorrelation/)
assert.match(entry, /position_correlation_cap/)
assert.doesNotMatch(entry, /sectorCountMap\.get\(recSector\).*>= 2/)
// C28-01: the overlap minimum is the KV value, never a literal.
const rotation = readFileSync('src/lib/l4RotationGate.ts', 'utf8')
for (const source of [entry, rotation]) {
  assert.match(source, /minimumOverlappingReturns:\s*riskCfg\.position\.minCorrelationOverlap/)
  assert.doesNotMatch(source, /minimumOverlappingReturns:\s*\d/)
}

console.log('position risk distribution contract passed')
