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

console.log('position risk distribution contract passed')
