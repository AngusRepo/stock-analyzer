import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildPaperKellyObservations,
  evaluatePaperKellyCalibration,
  fitPavCalibrationBins,
  resolvePaperKellyPct,
  type PaperKellyObservation,
} from './paperKellyCalibration'

async function main(): Promise<void> {
const fifo = buildPaperKellyObservations([
  {
    id: 1,
    symbol: '2330',
    side: 'buy',
    shares: 100,
    price: 100,
    commission: 10,
    tax: 0,
    source: 'auto_ml',
    confidence: 0.8,
    note: JSON.stringify({ ml_confidence_semantic: 'active8-v5|net-return-v1' }),
    created_at: '2026-07-01 09:00:00',
  },
  {
    id: 2,
    symbol: '2330',
    side: 'sell',
    shares: 100,
    price: 110,
    commission: 10,
    tax: 30,
    source: 'eod_exit',
    confidence: null,
    note: null,
    created_at: '2026-07-05 13:30:00',
  },
])
assert.equal(fifo.length, 1)
assert.equal(fifo[0].observationId, '1:2:0')
assert.equal(fifo[0].confidence, 0.8)
assert(Math.abs(fifo[0].netReturn - (109.6 / 100.1 - 1)) < 1e-8, 'FIFO return must include proportional buy/sell costs')

const tied: PaperKellyObservation[] = [
  { observationId: 'a', buyOrderId: 1, sellOrderId: 11, symbol: 'A', signalDate: '2026-01-01', outcomeDate: '2026-01-02', confidence: 0.5, confidenceSemantic: 'active8-v5|net-return-v1', netReturn: 0.01, matchedShares: 1 },
  { observationId: 'b', buyOrderId: 2, sellOrderId: 12, symbol: 'B', signalDate: '2026-01-01', outcomeDate: '2026-01-02', confidence: 0.5, confidenceSemantic: 'active8-v5|net-return-v1', netReturn: -0.01, matchedShares: 1 },
  { observationId: 'c', buyOrderId: 3, sellOrderId: 13, symbol: 'C', signalDate: '2026-01-01', outcomeDate: '2026-01-02', confidence: 0.8, confidenceSemantic: 'active8-v5|net-return-v1', netReturn: 0.02, matchedShares: 1 },
]
const tiedBins = fitPavCalibrationBins(tied)
assert.equal(tiedBins[0].sampleCount, 2, 'equal confidence must remain one calibration group')
assert(tiedBins.every((bin, index) => index === 0 || tiedBins[index - 1].calibratedProbability <= bin.calibratedProbability))

const observations: PaperKellyObservation[] = []
for (let day = 1; day <= 20; day += 1) {
  const date = `2026-07-${String(day).padStart(2, '0')}`
  for (let index = 0; index < 3; index += 1) {
    observations.push({
      observationId: `${date}:low:${index}`,
      buyOrderId: day * 100 + index,
      sellOrderId: day * 1000 + index,
      symbol: `L${index}`,
      signalDate: date,
      outcomeDate: date,
      confidence: 0.2,
      confidenceSemantic: 'active8-v5|net-return-v1',
      netReturn: -0.02,
      matchedShares: 100,
    })
    observations.push({
      observationId: `${date}:high:${index}`,
      buyOrderId: day * 100 + 10 + index,
      sellOrderId: day * 1000 + 10 + index,
      symbol: `H${index}`,
      signalDate: date,
      outcomeDate: date,
      confidence: 0.8,
      confidenceSemantic: 'active8-v5|net-return-v1',
      netReturn: 0.04,
      matchedShares: 100,
    })
  }
}
const evaluated = await evaluatePaperKellyCalibration({
  observations,
  knowledgeCutoffDate: '2026-07-21',
  allowPromotion: true,
})
assert.equal(evaluated.status, 'promoted')
assert.equal(evaluated.confidenceSemantic, 'active8-v5|net-return-v1')
assert(evaluated.artifact)
assert(Object.values(evaluated.gates).every(Boolean))
assert((evaluated.metrics.calibratedBrier ?? Infinity) < (evaluated.metrics.rawBrier ?? -Infinity))
const highKelly = resolvePaperKellyPct(evaluated.artifact, 0.8, 0.15, evaluated.artifact?.confidenceSemantic)
assert(highKelly && highKelly.pct > 0 && highKelly.pct <= 0.15)
assert.equal(resolvePaperKellyPct(evaluated.artifact, 0.2, 0.15, evaluated.artifact?.confidenceSemantic), null)
assert.equal(resolvePaperKellyPct(evaluated.artifact, 0.8, 0.15, 'different-semantic'), null)

const orchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const entry = fs.readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const weekly = fs.readFileSync('src/lib/durableSchedulerTask.ts', 'utf8')
const migration = fs.readFileSync('domain-migrations/paper/0003_paper_kelly_calibration.sql', 'utf8')
assert(!orchestrator.includes('function calcKellyPct('), 'raw-confidence Kelly formula must be retired')
assert(orchestrator.includes('loadPromotedPaperKellyCalibrationBefore'))
assert(orchestrator.includes('paper_kelly_artifact:'))
assert(entry.includes('Math.min(requestedBaseBudget, kellyBudget)'), 'Kelly must be a cap, never a floor')
assert(entry.includes("'kelly_cap'"))
assert(weekly.includes('refreshPaperKellyCalibration'))
assert(weekly.includes('allowPromotion: true'))
for (const table of [
  'paper_kelly_calibration_runs_v1',
  'paper_kelly_calibration_artifacts_v1',
  'paper_kelly_calibration_head_v1',
]) assert(migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`))

console.log('paper Kelly calibration tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
