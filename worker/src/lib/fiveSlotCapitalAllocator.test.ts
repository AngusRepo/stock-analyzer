import {
  buildFiveSlotCapitalPlan,
  fiveSlotHoldingWeaknessScore,
  formatFiveSlotDecisionWatchPoint,
  inferFiveSlotTargetExposure,
  inferFiveSlotTargetExposureFromContext,
} from './fiveSlotCapitalAllocator'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const baseConfig = {
  maxPositions: 5,
  maxPctOfPortfolio: 0.25,
  maxPctOfCash: 0.30,
  dailyBuyLimit: 800_000,
  minPositionValue: 30_000,
  swapThreshold: 1.15,
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 800_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [
      { symbol: 'A', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: 'B', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: 'C', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: 'D', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: 'E', shares: 1000, avgCost: 100, lastPrice: 100 },
    ],
    candidates: [{ symbol: 'F', confidence: 0.78, score: 72, riskPct: 0.015 }],
  })
  const decision = plan.decisions.get('F')
  assert(decision?.action === 'skip', 'full 5-slot portfolio must not open a sixth position')
  assert(decision?.reason === 'allocator_full_requires_replacement', 'full portfolio skip should name replacement requirement')
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 800_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [
      { symbol: '2330', shares: 400, avgCost: 100, lastPrice: 100 },
      { symbol: '2454', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: '2317', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: '2308', shares: 1000, avgCost: 100, lastPrice: 100 },
      { symbol: '3711', shares: 1000, avgCost: 100, lastPrice: 100 },
    ],
    candidates: [{ symbol: '2330', confidence: 0.82, score: 80, riskPct: 0.015 }],
  })
  const decision = plan.decisions.get('2330')
  assert(decision?.action === 'add', 'underweight existing slot should allow add-on even when maxPositions is reached')
  assert((decision?.budgetCap ?? 0) > 0, 'add-on decision should expose remaining slot budget')
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 800_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [{ symbol: '2330', shares: 2000, avgCost: 100, lastPrice: 100 }],
    candidates: [{ symbol: '2330', confidence: 0.70, score: 70, riskPct: 0.015 }],
  })
  const decision = plan.decisions.get('2330')
  assert(decision?.action === 'hold', 'fully sized existing slot should produce hold instead of another buy')
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 800_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [
      { symbol: 'WEAK', shares: 1000, avgCost: 100, lastPrice: 92, daysHeld: 8, tp1Hit: false },
      { symbol: 'B', shares: 1000, avgCost: 100, lastPrice: 103, daysHeld: 8, tp1Hit: true },
      { symbol: 'C', shares: 1000, avgCost: 100, lastPrice: 104, daysHeld: 8, tp1Hit: true },
      { symbol: 'D', shares: 1000, avgCost: 100, lastPrice: 105, daysHeld: 8, tp1Hit: true },
      { symbol: 'E', shares: 1000, avgCost: 100, lastPrice: 106, daysHeld: 8, tp1Hit: true },
    ],
    candidates: [{ symbol: 'STRONG', confidence: 0.84, score: 83, riskPct: 0.015 }],
  })
  const decision = plan.decisions.get('STRONG')
  assert(decision?.action === 'replace', 'strong candidate should be eligible to replace a weak full-slot holding')
  assert(decision?.replaceSymbol === 'WEAK', 'replace decision should name the weakest holding')
  const watchPoint = decision ? formatFiveSlotDecisionWatchPoint(decision) : ''
  assert(watchPoint.startsWith('allocator:replace:allocator_replace_weakest_slot:'), 'allocator decision should have a structured watch point')
  assert(watchPoint.includes('replace=WEAK'), 'allocator watch point should expose replacement target')
}

{
  const plan = buildFiveSlotCapitalPlan({
    account: { cash: 700_000, totalPortfolio: 1_000_000, dailyRemaining: 800_000 },
    marketRiskLevel: 'low',
    config: baseConfig,
    holdings: [
      { symbol: 'STALE', shares: 7000, avgCost: 14.97, lastPrice: 14.85, trailingStop: 14.65, daysHeld: 20, tp1Hit: false },
      { symbol: 'NEARSTOP', shares: 2000, avgCost: 70.5, lastPrice: 67.4, trailingStop: 66.96, daysHeld: 6, tp1Hit: false },
      { symbol: 'C', shares: 1000, avgCost: 100, lastPrice: 104, trailingStop: 90, daysHeld: 1, tp1Hit: true },
      { symbol: 'D', shares: 1000, avgCost: 100, lastPrice: 105, trailingStop: 90, daysHeld: 1, tp1Hit: true },
      { symbol: 'E', shares: 1000, avgCost: 100, lastPrice: 106, trailingStop: 90, daysHeld: 1, tp1Hit: true },
    ],
    candidates: [{ symbol: 'CANDIDATE', confidence: 0.78, score: 24.04, riskPct: 0.017 }],
  })
  const decision = plan.decisions.get('CANDIDATE')
  assert(decision?.action === 'replace', 'near-stop replacement should not be blocked by a stale-only weakest holding')
  assert(decision?.replaceSymbol === 'NEARSTOP', 'candidate should be allowed to replace the near-stop holding it clears')
  assert((decision?.replaceRequiredRank ?? 0) > 0, 'replacement decision should expose required rank')
  assert(formatFiveSlotDecisionWatchPoint(decision!).includes('required='), 'replacement watch point should expose required rank')
}

{
  assert(inferFiveSlotTargetExposure('low') > inferFiveSlotTargetExposure('orange'), 'orange risk should reduce target exposure')
  assert(inferFiveSlotTargetExposure('black') === 0, 'black risk should halt new exposure')
  assert(
    inferFiveSlotTargetExposure('yellow') > 0.60 && inferFiveSlotTargetExposure('yellow') < 0.70,
    'yellow fallback should remain near the old 65% operational posture',
  )
  assert(
    inferFiveSlotTargetExposureFromContext({
      marketRiskLevel: 'yellow',
      riskScore: 34,
      marketOutlookUpsidePct: 6.5,
      regimeFamily: 'bull',
    }) > inferFiveSlotTargetExposure('yellow'),
    'constructive outlook and bull regime should lift target exposure through the continuous context curve',
  )
  assert(
    inferFiveSlotTargetExposureFromContext({
      marketRiskLevel: 'yellow',
      riskScore: 72,
      marketOutlookUpsidePct: 0.4,
      regimeFamily: 'bear',
    }) < inferFiveSlotTargetExposure('orange'),
    'high risk score plus weak outlook should cut exposure below the orange fallback',
  )
  assert(
    fiveSlotHoldingWeaknessScore({ symbol: 'WEAK', shares: 1000, avgCost: 100, lastPrice: 92, daysHeld: 8, tp1Hit: false }) > 35,
    'weakness score should expose the same replacement evidence used by paper auto-swap',
  )
}
