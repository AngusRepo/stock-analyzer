import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  STRATEGY_REPLACEMENT_POLICY_V7,
  applyHolmCorrectionV7,
  evaluateDependenceAdjustedMeanV7,
  evaluatePowerAtMinimumEconomicDeltaV7,
  evaluatePairedStrategyReplacementsV6,
  evaluatePairedStrategyReplacementsV7,
  evaluateStrategyMarginalEdgesV4,
  evaluateStrategyPortfolioEdgeV4,
  type OutcomeCell,
} from './strategyMarginalEdgeV4'

const cells: OutcomeCell[] = []
for (let day = 1; day <= 12; day++) {
  const date = `2026-07-${String(day).padStart(2, '0')}`
  const goodResidual = 0.012 + (day % 3) * 0.002
  const badResidual = -0.012 + (day % 2) * 0.003
  for (const strategy of ['A', 'B']) {
    cells.push({
      signal_date: date,
      symbol: 'GOOD',
      strategy_id: strategy,
      strategy_version: 'v1',
      family_id: 'TREND_RECLAIM_CONTINUATION',
      production_owner: strategy === 'B' ? 1 : 0,
      strategy_hit: strategy === 'A' ? 1 : 0,
      absolute_return_net: goodResidual + 0.003,
      residual_return_net: goodResidual,
    })
    cells.push({
      signal_date: date,
      symbol: 'BAD',
      strategy_id: strategy,
      strategy_version: 'v1',
      family_id: 'TREND_RECLAIM_CONTINUATION',
      production_owner: strategy === 'B' ? 1 : 0,
      strategy_hit: strategy === 'B' ? 1 : 0,
      absolute_return_net: badResidual - 0.002,
      residual_return_net: badResidual,
    })
  }
}

const result = evaluateStrategyMarginalEdgesV4(cells)
const good = result.find((row) => row.strategyId === 'A')!
const bad = result.find((row) => row.strategyId === 'B')!
assert.equal(good.observationDates, 12)
assert.equal(good.productionEligible, true, 'candidate strategy needs at least ten OOS dates and positive cost-net edge')
assert(good.marginalEdgeMean! > 0)
assert(good.marginalEdgeLcb90! > 0)
assert.equal(bad.productionEligible, false)
assert(bad.marginalEdgeMean! < 0)
assert.equal(bad.productionWeightRaw, 0)

const portfolio = evaluateStrategyPortfolioEdgeV4(cells, new Map([['A|v1', 1]]))
assert.equal(portfolio.length, 12)
assert(portfolio.every((row) => row.residualReturn > 0 && row.absoluteReturn > 0))

const replacement = evaluatePairedStrategyReplacementsV6(
  cells,
  result,
  new Map([['B|v1', 1]]),
)
assert.equal(replacement.accepted.length, 1, 'positive same-family paired evidence should replace one weak active')
assert.equal(replacement.accepted[0].candidateKey, 'A|v1')
assert.equal(replacement.accepted[0].incumbentKey, 'B|v1')
assert.equal(replacement.finalWeights.size, 1, 'one-in-one-out cutover must keep production strategy count stable')
assert(replacement.finalWeights.has('A|v1'))
assert(!replacement.finalWeights.has('B|v1'))
assert(replacement.globalPaired.lcb90! > 0)
assert(replacement.globalRiskPass)

const crossFamilyCells = cells
  .filter((row) => row.strategy_id !== 'A')
  .concat(cells.filter((row) => row.strategy_id === 'A').map((row) => ({
    ...row,
    strategy_id: 'C',
    family_id: 'REVENUE_QUALITY_MOMENTUM',
  })))
const crossFamilyEdges = evaluateStrategyMarginalEdgesV4(crossFamilyCells)
const crossFamilyReplacement = evaluatePairedStrategyReplacementsV6(
  crossFamilyCells,
  crossFamilyEdges,
  new Map([['B|v1', 1]]),
)
assert.equal(crossFamilyReplacement.accepted.length, 1, 'cross-family replacement should pass only through paired portfolio gates')
assert.equal(crossFamilyReplacement.accepted[0].candidateKey, 'C|v1')
assert.equal(crossFamilyReplacement.accepted[0].replacementScope, 'cross_family')
assert.equal(crossFamilyReplacement.accepted[0].incumbentFamilyId, 'TREND_RECLAIM_CONTINUATION')
assert.equal(crossFamilyReplacement.globalCorrelationPass, true)
assert.equal(crossFamilyReplacement.globalTurnoverPass, true)
assert.equal(crossFamilyReplacement.globalRiskPass, true)

const insufficient = evaluateStrategyMarginalEdgesV4(cells.filter((row) => row.signal_date <= '2026-07-05'))
assert.equal(
  insufficient.find((row) => row.strategyId === 'A')?.productionEligible,
  false,
  'five dates must not pass the unified ten-date production gate',
)

assert.equal(STRATEGY_REPLACEMENT_POLICY_V7.hac_lag, 4)
assert.equal(STRATEGY_REPLACEMENT_POLICY_V7.outcome_horizon_trading_days, 5)
assert.equal(STRATEGY_REPLACEMENT_POLICY_V7.min_effective_paired_dates, 30)
assert.equal(STRATEGY_REPLACEMENT_POLICY_V7.familywise_alpha, 0.05)
assert.equal(STRATEGY_REPLACEMENT_POLICY_V7.min_power_at_minimum_economic_delta, 0.8)

const alternatingDeltas = Array.from({ length: 100 }, (_, index) => index % 2 === 0 ? 0.012 : -0.008)
const seriallyCorrelatedDeltas = Array.from(
  { length: 100 },
  (_, index) => Math.floor(index / 5) % 2 === 0 ? 0.012 : -0.008,
)
const alternatingStats = evaluateDependenceAdjustedMeanV7(alternatingDeltas, 1)
const serialStats = evaluateDependenceAdjustedMeanV7(seriallyCorrelatedDeltas, 1)
assert.equal(serialStats.hacLag, 4, 'T+5 overlap must never use a HAC lag below four')
assert(serialStats.hacStandardError! > alternatingStats.hacStandardError! * 1.3)
assert(serialStats.effectiveDates! < alternatingStats.effectiveDates!)
assert(serialStats.lcb95Hac! <= 0, 'serial dependence must block a naive positive mean false positive')
assert(serialStats.powerAtMinimumEconomicDelta! < 0.8, 'underpowered overlapping evidence must remain shadow-only')

const holm = applyHolmCorrectionV7([
  { key: 'candidate-a->incumbent-a', pValue: 0.01 },
  { key: 'candidate-b->incumbent-b', pValue: 0.03 },
  { key: 'candidate-c->incumbent-c', pValue: 0.04 },
])
assert.deepEqual(holm.map((row) => row.rejected), [true, false, false])
assert(Math.abs(holm[0].adjustedPValue - 0.03) < 1e-12)
assert(Math.abs(holm[1].adjustedPValue - 0.06) < 1e-12)
assert(Math.abs(holm[2].adjustedPValue - 0.06) < 1e-12)
const tiedHolm = applyHolmCorrectionV7([
  { key: 'z-proposal', pValue: 0.01 },
  { key: 'a-proposal', pValue: 0.01 },
])
assert.equal(tiedHolm.find((row) => row.key === 'a-proposal')?.rank, 1, 'Holm ties need deterministic proposal-key ordering')

const baseAlphaPower = evaluatePowerAtMinimumEconomicDeltaV7(0.00038, 0.05)
const holmLocalPower = evaluatePowerAtMinimumEconomicDeltaV7(0.00038, 0.05 / 3)
assert(baseAlphaPower! >= 0.8)
assert(holmLocalPower! < 0.8, 'proposal power must be recomputed at its stricter Holm local alpha')
assert(holmLocalPower! < baseAlphaPower!)

const v7Insufficient = evaluatePairedStrategyReplacementsV7(
  cells,
  result,
  new Map([['B|v1', 1]]),
)
assert.equal(v7Insufficient.accepted.length, 0, 'the twelve-date V6 promotion must remain shadow under the V7 ESS gate')
assert(v7Insufficient.proposals[0].rejectionReasons.includes('effective_paired_dates_below_minimum'))

const matureCells: OutcomeCell[] = []
for (let index = 0; index < 100; index += 1) {
  const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10)
  const candidateResidual = 0.012 + (index % 5) * 0.0004
  const incumbentResidual = -0.006 + ((index * 3) % 7) * 0.0003
  for (const strategy of ['MATURE', 'INCUMBENT']) {
    matureCells.push({
      signal_date: date,
      symbol: 'MATURE_GOOD',
      strategy_id: strategy,
      strategy_version: 'v1',
      family_id: strategy === 'MATURE' ? 'REVENUE_QUALITY_MOMENTUM' : 'TREND_RECLAIM_CONTINUATION',
      production_owner: strategy === 'INCUMBENT' ? 1 : 0,
      strategy_hit: strategy === 'MATURE' ? 1 : 0,
      absolute_return_net: candidateResidual + 0.003,
      residual_return_net: candidateResidual,
    })
    matureCells.push({
      signal_date: date,
      symbol: 'MATURE_BAD',
      strategy_id: strategy,
      strategy_version: 'v1',
      family_id: strategy === 'MATURE' ? 'REVENUE_QUALITY_MOMENTUM' : 'TREND_RECLAIM_CONTINUATION',
      production_owner: strategy === 'INCUMBENT' ? 1 : 0,
      strategy_hit: strategy === 'INCUMBENT' ? 1 : 0,
      absolute_return_net: incumbentResidual - 0.002,
      residual_return_net: incumbentResidual,
    })
  }
}
const matureEdges = evaluateStrategyMarginalEdgesV4(matureCells)
const matureV7 = evaluatePairedStrategyReplacementsV7(
  matureCells,
  matureEdges,
  new Map([['INCUMBENT|v1', 1]]),
)
assert.equal(matureV7.accepted.length, 1, 'mature, powered HAC/Holm evidence must still permit atomic replacement')
assert.equal(matureV7.accepted[0].candidateKey, 'MATURE|v1')
assert.equal(matureV7.accepted[0].holmRejected, true)
assert(matureV7.accepted[0].pairedDeltaLcb95Hac! > 0)
assert(matureV7.accepted[0].candidateAbsoluteLcb95Hac! > 0)
assert(matureV7.globalAbsoluteConfidence.lcb95Hac! > 0)
assert(matureV7.accepted[0].effectivePairedDates! >= STRATEGY_REPLACEMENT_POLICY_V7.min_effective_paired_dates)
assert(matureV7.accepted[0].pairedDeltaPowerAtMinimumEconomicDelta! >= 0.8)
assert.equal(matureV7.globalRiskPass, true)
assert.equal(matureV7.finalWeights.size, 1)
const source = fs.readFileSync('src/lib/strategyMarginalEdgeV4.ts', 'utf8')
const orchestratorSource = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert.match(source, /canonicalRunIds\?: Record<string, string>/)
assert.match(source, /Object\.entries\(options\.canonicalRunIds \?\? \{\}\)/)
assert.match(source, /m\.signal_date=\?[\s\S]*m\.producer_run_id=\?/)
assert.doesNotMatch(source, /canonicalOwnerClause/)
assert.match(
  orchestratorSource,
  /refreshStrategyMarginalEdgeV4\(learningDb, asOfDate, \{ canonicalRunIds \}\)/,
)
assert.match(
  source,
  /l\.outcome_known_date <= \?/,
  'replacement inference must never consume a T+5 outcome that was unknown at the run cutoff',
)

const noisyAbsoluteCells = matureCells.map((row, index) => row.symbol === 'MATURE_GOOD'
  ? {
      ...row,
      absolute_return_net: Math.floor(index / 4) % 10 < 5 ? 0.012 : -0.010,
    }
  : row)
const noisyAbsoluteEdges = evaluateStrategyMarginalEdgesV4(noisyAbsoluteCells)
assert(noisyAbsoluteEdges.find((row) => row.strategyId === 'MATURE')!.absoluteHitReturnMean! > 0)
const noisyAbsoluteV7 = evaluatePairedStrategyReplacementsV7(
  noisyAbsoluteCells,
  noisyAbsoluteEdges,
  new Map([['INCUMBENT|v1', 1]]),
)
assert.equal(noisyAbsoluteV7.accepted.length, 0)
assert(noisyAbsoluteV7.proposals[0].rejectionReasons.includes(
  'candidate_absolute_cost_net_lcb95_hac_not_positive',
), 'positive absolute mean with a non-positive HAC LCB must remain shadow-only')

console.log('strategyMarginalEdgeV4 tests passed')
