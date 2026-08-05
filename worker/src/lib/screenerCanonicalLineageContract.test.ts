import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const suffix = ':TW:production:market_screener'
const producer = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
assert.match(
  producer,
  /`screener:\$\{input\.date\}:TW:production:market_screener`/,
  'screener producer must promote the full canonical logical run key',
)

const consumers = [
  './canonicalSelectionLabels.ts',
  './s12ResearchStructureSnapshots.ts',
  './s12ReplayTradeOutcome.ts',
  './strategyMarginalEdgeV4.ts',
  './strategyLearningRunState.ts',
  './selectionReferenceEvidence.ts',
  './strategyLearning.ts',
  '../../../ml-controller/services/allocator_ev_feature_snapshot_backfill.py',
]

for (const relativePath of consumers) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const canonicalChecks = [...source.matchAll(
    /logical_run_key\s*=\s*['"]screener:['"]\s*\|\|\s*[rm]\.signal_date([^\n]*)/g,
  )]
  assert.ok(canonicalChecks.length > 0, `${relativePath} must enforce canonical screener lineage`)
  for (const check of canonicalChecks) {
    assert.match(
      check[1],
      /\|\|\s*['"]:TW:production:market_screener['"]/,
      `${relativePath} canonical consumer key must match the producer suffix ${suffix}`,
    )
  }
}
