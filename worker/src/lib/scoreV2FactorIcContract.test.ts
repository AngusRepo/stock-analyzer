import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/lib/marketScreener.ts', 'utf8')
const start = source.indexOf('export async function calcFactorIC')
const end = source.indexOf('export async function analyzeMAE', start)
assert(start >= 0 && end > start, 'calcFactorIC block should be locatable')
const block = source.slice(start, end)

assert(block.includes('score_components'), 'factor IC should select canonical Score V2 payload')
assert(block.includes('readScoreV2Snapshot'), 'factor IC should derive factors through Score V2 snapshot')
for (const factor of ['mlEdge', 'chipFlow', 'technicalStructure', 'fundamentalQuality', 'newsTheme', 'finalScore']) {
  assert(block.includes(`name: '${factor}'`), `factor IC should report ${factor}`)
}
assert(!block.includes("const factors = ['chip_score', 'tech_score', 'ml_score', 'total_score']"), 'factor IC must not use legacy factor list')
assert(!block.includes('r.score as total_score'), 'factor IC must not alias scalar score as legacy total_score')
