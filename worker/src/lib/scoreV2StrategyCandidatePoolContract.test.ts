import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const candidatePool = readFileSync('src/lib/strategyCandidatePool.ts', 'utf8')
const strategySpec = readFileSync('src/lib/strategySpec.ts', 'utf8')

const thresholdScoresStart = candidatePool.indexOf('function candidatePoolThresholdScores')
const thresholdScoresEnd = candidatePool.indexOf('function thresholdNearMisses', thresholdScoresStart)
assert(thresholdScoresStart >= 0 && thresholdScoresEnd > thresholdScoresStart, 'candidate pool threshold score block should be locatable')
const thresholdScoresBlock = candidatePool.slice(thresholdScoresStart, thresholdScoresEnd)

for (const legacyField of ['row.score', 'row.chip_score', 'row.tech_score', 'row.momentum_score']) {
  assert(!thresholdScoresBlock.includes(legacyField), `candidate pool must not read legacy scalar fallback ${legacyField}`)
}
assert(thresholdScoresBlock.includes('seedScore: canonical.seedScore'), 'candidate pool should use canonical seed score only')
assert(thresholdScoresBlock.includes('chipFlow: canonical.chipFlow'), 'candidate pool should use canonical chip flow only')
assert(
  thresholdScoresBlock.includes('technicalStructure: canonical.technicalStructure'),
  'candidate pool should use canonical technical structure only',
)
assert(thresholdScoresBlock.includes('momentumScore: canonical.momentumScore'), 'candidate pool should use canonical momentum score only')

const deriveScoresStart = strategySpec.indexOf('export function deriveStrategyThresholdScores')
const deriveScoresEnd = strategySpec.indexOf('export function assessCandidateAgainstStrategySpecs', deriveScoresStart)
assert(deriveScoresStart >= 0 && deriveScoresEnd > deriveScoresStart, 'strategy threshold derivation block should be locatable')
const deriveScoresBlock = strategySpec.slice(deriveScoresStart, deriveScoresEnd)

assert(!deriveScoresBlock.includes('storageSeed'), 'strategy threshold derivation must not keep scalar score compatibility')
assert(!deriveScoresBlock.includes('.score)'), 'strategy threshold derivation must not read scalar score fallback')
assert(!deriveScoresBlock.includes('candidate.score_components'), 'strategy threshold derivation must not read storage score_components directly')
assert(deriveScoresBlock.includes('scoreV2StorageRow(candidate)'), 'strategy threshold derivation should adapt runtime score_v2 through taxonomy storage boundary')
assert(deriveScoresBlock.includes('seedScore: canonicalFinal ?? snapshot.finalScore'), 'strategy seed score should come from Score V2 finalScore or canonical total')
