import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const strategyOutcomes = fs.readFileSync('src/lib/strategyMultiHorizonOutcomes.ts', 'utf8')

assert(
  postMarketChain.includes("'price-horizon-projection'") &&
    postMarketChain.includes('maxProcessDates: 8') &&
    postMarketChain.includes('timeoutMs: 240_000') &&
    postMarketChain.includes('stageMs.canonical_labels') &&
    postMarketChain.includes('stageMs.multi_horizon_labels') &&
    postMarketChain.includes("'strategy-multi-horizon-outcomes'") &&
    postMarketChain.includes('post_verify_chain_failed:strategy-multi-horizon-outcomes:') &&
    postMarketChain.includes("'strategy-evidence-current'") &&
    postMarketChain.includes('stageMs.strategy_evidence_metrics') &&
    postMarketChain.includes('stageMs.strategy_evidence_owner_calibration') &&
    postMarketChain.includes("'strategy-evidence-metric-backfill'") &&
    postMarketChain.includes('critical: false, timeoutMs: 180_000') &&
    postMarketChain.includes('stage_ms=${JSON.stringify(stageMs)}'),
  'post-verify must isolate bounded price projection and current evidence from non-critical historical backfill',
)
assert(
  strategyOutcomes.includes('const DEFAULT_OUTCOME_LOOKBACK_DAYS = 120') &&
    strategyOutcomes.includes('const OUTCOME_ROWS_PER_STATEMENT = 100') &&
    strategyOutcomes.includes('const OUTCOME_BATCH_STATEMENTS = 20') &&
    strategyOutcomes.includes('chunks(rows, OUTCOME_ROWS_PER_STATEMENT)') &&
    strategyOutcomes.includes('FROM json_each(?) WHERE 1') &&
    strategyOutcomes.includes('return rows.length'),
  'the bounded outcome refresh must use JSON batches with one D1 binding per 100 rows',
)

console.log('post-verify projection performance contract tests passed')