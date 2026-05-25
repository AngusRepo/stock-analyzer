import { readFileSync } from 'node:fs'
import {
  buildFiveSlotExecutionDecision,
  buildFiveSlotCapitalPlan,
  fiveSlotHoldingWeaknessScore,
  formatFiveSlotDecisionWatchPoint,
  inferFiveSlotTargetExposure,
} from './fiveSlotCapitalAllocator'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const allocatorSource = readFileSync('src/lib/fiveSlotCapitalAllocator.ts', 'utf8')
const paperEntryTasksSource = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')

assert(
  allocatorSource.includes("score_v2?: Pick<ScoreV2SnapshotSummary, 'finalScore' | 'total'> | null"),
  'five-slot allocator candidate contract should accept canonical score_v2 summaries',
)
assert(
  !allocatorSource.includes('score?: number'),
  'five-slot allocator candidate contract must not expose scalar score',
)
assert(
  paperEntryTasksSource.includes('score_v2: pending.score_v2 ?? null'),
  'paper entry capital allocator call sites should pass canonical pending score_v2',
)
assert(
  paperEntryTasksSource.includes('buildFiveSlotExecutionDecision'),
  'paper entry execution must re-evaluate allocator per candidate so unfilled earlier candidates do not reserve a slot',
)
assert(
  !paperEntryTasksSource.includes('score: pending.score'),
  'paper entry capital allocator call sites must not pass scalar pending score',
)

function scoreV2(finalScore: number) {
  return { finalScore, total: finalScore }
}

const baseConfig = {
  maxPositions: 5,
  maxPctOfPortfolio: 0.25,
  maxPctOfCash: 0.30,
  dailyBuyLimit: 500_000,
  minPositionValue: 30_000,
  swapThreshold: 1.15,
}

{
  const holdings = [
    { symbol: '1609', shares: 1600, avgCost: 35, lastPrice: 35 },
    { symbol: '6215', shares: 265, avgCost: 130, lastPrice: 130 },
    { symbol: '8069', shares: 353, avgCost: 218, lastPrice: 218 },
    { symbol: '9914', shares: 772, avgCost: 70, lastPrice: 70, daysHeld: 7, tp1Hit: false },
  ]
  const firstCandidate = { symbol: '6126', confidence: 0.72, score_v2: scoreV2(60), riskPct: 0.010 }
  const secondCandidate = { symbol: '6271', confidence: 0.72, score_v2: scoreV2(59), riskPct: 0.010 }
  const batchPlan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 500_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings,
    candidates: [firstCandidate, secondCandidate],
  })
  assert(batchPlan.decisions.get('6126')?.action === 'buy', 'first candidate can consume the open slot in a batch plan')
  assert(
    batchPlan.decisions.get('6271')?.action !== 'buy',
    'batch planner documents the reservation behavior that execution must not use for unfilled candidates',
  )
  const justInTimeDecision = buildFiveSlotExecutionDecision({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 500_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings,
    candidate: secondCandidate,
  })
  assert(
    justInTimeDecision?.action === 'buy',
    'single-candidate execution decision should see the actual open slot when earlier candidates have not filled',
  )
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 500_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [
      { symbol: 'A', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: 'B', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: 'C', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: 'D', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: 'E', shares: 1000, avgCost: 100, lastPrice: 100 },
    ],
    candidates: [{ symbol: 'F', confidence: 0.78, score_v2: scoreV2(72), riskPct: 0.015 }],
  })
  const decision = plan.decisions.get('F')
  assert(decision?.action === 'skip', 'full 5-slot portfolio must not open a sixth position')
  assert(decision?.reason === 'allocator_full_requires_replacement', 'full portfolio skip should name replacement requirement')
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 500_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [
      { symbol: '2330', shares: 400, avgCost: 100, lastPrice: 100 },
      { symbol: '2454', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: '2317', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: '2308', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: '3711', shares: 1000, avgCost: 100, lastPrice: 100 },
    ],
    candidates: [{ symbol: '2330', confidence: 0.82, score_v2: scoreV2(80), riskPct: 0.015 }],
  })
  const decision = plan.decisions.get('2330')
  assert(decision?.action === 'add', 'underweight existing slot should allow add-on even when maxPositions is reached')
  assert((decision?.budgetCap ?? 0) > 0, 'add-on decision should expose remaining slot budget')
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 500_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [{ symbol: '2330', shares: 2000, avgCost: 100, lastPrice: 100 }],
    candidates: [{ symbol: '2330', confidence: 0.70, score_v2: scoreV2(70), riskPct: 0.015 }],
  })
  const decision = plan.decisions.get('2330')
  assert(decision?.action === 'hold', 'fully sized existing slot should produce hold instead of another buy')
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 500_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [
      { symbol: 'WEAK', shares: 1000, avgCost: 100, lastPrice: 92, daysHeld: 8, tp1Hit: false },
      { symbol: 'B', shares: 1000, avgCost: 100, lastPrice: 103, daysHeld: 8, tp1Hit: true },
      { symbol: 'C', shares: 1000, avgCost: 100, lastPrice: 104, daysHeld: 8, tp1Hit: true },
      { symbol: 'D', shares: 1000, avgCost: 100, lastPrice: 105, daysHeld: 8, tp1Hit: true },
      { symbol: 'E', shares: 1000, avgCost: 100, lastPrice: 106, daysHeld: 8, tp1Hit: true },
    ],
    candidates: [{ symbol: 'STRONG', confidence: 0.84, score_v2: scoreV2(83), riskPct: 0.015 }],
  })
  const decision = plan.decisions.get('STRONG')
  assert(decision?.action === 'replace', 'strong candidate should be eligible to replace a weak full-slot holding')
  assert(decision?.replaceSymbol === 'WEAK', 'replace decision should name the weakest holding')
  const watchPoint = decision ? formatFiveSlotDecisionWatchPoint(decision) : ''
  assert(watchPoint.startsWith('allocator:replace:allocator_replace_weakest_slot:'), 'allocator decision should have a structured watch point')
  assert(watchPoint.includes('replace=WEAK'), 'allocator watch point should expose replacement target')
}

{
  assert(inferFiveSlotTargetExposure('low') > inferFiveSlotTargetExposure('orange'), 'orange risk should reduce target exposure')
  assert(inferFiveSlotTargetExposure('black') === 0, 'black risk should halt new exposure')
  assert(
    fiveSlotHoldingWeaknessScore({ symbol: 'WEAK', shares: 1000, avgCost: 100, lastPrice: 92, daysHeld: 8, tp1Hit: false }) > 35,
    'weakness score should expose the same replacement evidence used by paper auto-swap',
  )
}
