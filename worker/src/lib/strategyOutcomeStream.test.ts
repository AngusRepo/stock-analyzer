import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { StrategyOutcomeStream } from './strategyOutcomeStream'
import {
  evaluateStrategyMarginalEdgesV4, evaluateStrategyPortfolioEdgeV4,
  evaluatePairedStrategyReplacementsV6, evaluatePairedStrategyReplacementsV7,
  type OutcomeCell,
} from './strategyMarginalEdgeV4'

const rows: OutcomeCell[] = []
for (let day = 1; day <= 40; day++) {
  for (let symbol = 0; symbol < 16; symbol++) {
    for (let strategy = 0; strategy < 12; strategy++) {
      const residual = (symbol < 8 ? 1 : -1) * (0.01 + day % 3 * 0.001)
      rows.push({
        signal_date: `2026-${day <= 28 ? '07' : '08'}-${String((day - 1) % 28 + 1).padStart(2, '0')}`,
        symbol: `STOCK-${symbol}`, strategy_id: `strategy-${strategy}`, strategy_version: 'v1',
        family_id: strategy < 6 ? 'TREND' : 'VALUE', production_owner: strategy === 1 ? 1 : 0,
        // Includes never-hit owners, both incumbent/candidate hits, and empty days.
        strategy_hit: day === 7 ? 0 : strategy === 0 ? Number(symbol < 8)
          : strategy === 1 ? Number(symbol >= 8) : Number(strategy < 9 && (day + symbol + strategy) % 11 === 0),
        absolute_return_net: residual + 0.003, residual_return_net: residual,
      })
    }
  }
}

const fullHash = createHash('sha256').update(JSON.stringify(rows.map(row => [
  row.signal_date, row.symbol, row.strategy_id, row.strategy_version, row.family_id,
  Number(row.production_owner), Number(row.strategy_hit),
  Number(row.absolute_return_net), Number(row.residual_return_net),
]))).digest('hex').slice(0, 20)
const fullEdges = evaluateStrategyMarginalEdgesV4(rows)
const weights = new Map([['strategy-1|v1', 1], ['strategy-9|v1', 0.5]])
for (const pageSize of [1, 17, 5000]) {
  const stream = new StrategyOutcomeStream()
  for (let i = 0; i < rows.length; i += pageSize) stream.append(rows.slice(i, i + pageSize))
  assert.equal(stream.sourceRows, rows.length)
  assert.equal(stream.finish(), fullHash)
  assert.equal(stream.finish(), fullHash)
  assert(stream.cells.length < rows.length / 3)
  assert.throws(() => stream.append([]), /already_finished/)
  const compactEdges = evaluateStrategyMarginalEdgesV4(stream.cells)
  assert.deepEqual(compactEdges, fullEdges)
  assert.deepEqual(evaluateStrategyPortfolioEdgeV4(stream.cells, weights), evaluateStrategyPortfolioEdgeV4(rows, weights))
  assert.deepEqual(evaluatePairedStrategyReplacementsV6(stream.cells, compactEdges, weights), evaluatePairedStrategyReplacementsV6(rows, fullEdges, weights))
  assert.deepEqual(evaluatePairedStrategyReplacementsV7(stream.cells, compactEdges, weights), evaluatePairedStrategyReplacementsV7(rows, fullEdges, weights))
}
const empty = new StrategyOutcomeStream()
assert.equal(empty.finish(), createHash('sha256').update('[]').digest('hex').slice(0, 20))
const inconsistent = new StrategyOutcomeStream()
inconsistent.append([rows[0]])
assert.throws(() => inconsistent.append([{ ...rows[1], residual_return_net: 9 }]), /cohort_inconsistent/)
const changedNonHit = new StrategyOutcomeStream()
changedNonHit.append(rows.map((row, index) => index === 10 ? { ...row, production_owner: 1 } : row))
assert.notEqual(changedNonHit.finish(), fullHash, 'non-hit source changes must still affect lineage')
console.log('strategyOutcomeStream: complete hash, sparse/dense cohort, V6/V7/portfolio exact parity passed')
