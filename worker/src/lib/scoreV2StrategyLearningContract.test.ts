import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/lib/strategyLearning.ts', 'utf8')
const contextStart = source.indexOf('const context = {')
const contextEnd = source.indexOf('rows.push({', contextStart)
assert(contextStart >= 0 && contextEnd > contextStart, 'strategy decision context block should be locatable')
const contextBlock = source.slice(contextStart, contextEnd)

assert(contextBlock.includes('score_v2'), 'strategy decision context should persist a Score V2 object')
assert(contextBlock.includes('finalScore: thresholdScores.seedScore'), 'strategy decision context should name finalScore explicitly')
assert(contextBlock.includes('chipFlow: thresholdScores.chipFlow'), 'strategy decision context should name chipFlow explicitly')
assert(
  contextBlock.includes('technicalStructure: thresholdScores.technicalStructure'),
  'strategy decision context should name technicalStructure explicitly',
)
assert(contextBlock.includes('momentumProxy: thresholdScores.momentumProxy'), 'strategy decision context should name momentumProxy explicitly')
assert(contextBlock.includes('source: thresholdScores.source'), 'strategy decision context should preserve Score V2 source')
assert(!contextBlock.includes('chip_score'), 'strategy decision context must not write legacy chip_score')
assert(!contextBlock.includes('tech_score'), 'strategy decision context must not write legacy tech_score')
assert(!contextBlock.includes('momentum_score'), 'strategy decision context must not write legacy momentum_score')
