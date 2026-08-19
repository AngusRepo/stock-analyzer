import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const strategyOutcomes = fs.readFileSync('src/lib/strategyMultiHorizonOutcomes.ts', 'utf8')

assert(
  postMarketChain.includes("'price-horizon-projection'") &&
    postMarketChain.includes('maxProcessDates: 8') &&
    postMarketChain.includes('timeoutMs: 360_000'),
  'post-verify projection must keep bounded work and a full-refresh safety budget',
)
assert(
  strategyOutcomes.includes('const DEFAULT_OUTCOME_LOOKBACK_DAYS = 120') &&
    strategyOutcomes.includes('const OUTCOME_ROWS_PER_STATEMENT = 5') &&
    strategyOutcomes.includes('const OUTCOME_BATCH_STATEMENTS = 100') &&
    strategyOutcomes.includes('chunks(rows, OUTCOME_ROWS_PER_STATEMENT)') &&
    strategyOutcomes.includes('group.flatMap((row) => [') &&
    strategyOutcomes.includes('return rows.length'),
  'the bounded outcome refresh must use <=95-bind multi-row UPSERTs instead of one D1 statement per row',
)

console.log('post-verify projection performance contract tests passed')