import { resolveAdaptiveExecutionPolicy } from './executionAdaptivePolicy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const policy = resolveAdaptiveExecutionPolicy({
    strategyMode: 'pullback',
    marketRiskLevel: 'low',
    base: {
      minVolumeRatio: 0.8,
      minRangePosition: 0.3,
      maxEntryChasePct: 0.006,
      strongBreakoutMaxEntryChasePct: 0.018,
    },
  })
  assert(policy.momentum.minVolumeRatio === 0.55, 'pullback should soften volume threshold')
  assert(policy.momentum.minRangePosition === 0.12, 'pullback should allow lower range position if support holds')
  assert(policy.policy.maxEntryChasePct === 0.003, 'pullback should shrink normal chase')
}

{
  const policy = resolveAdaptiveExecutionPolicy({
    strategyMode: 'breakout',
    marketRiskLevel: 'low',
    base: {
      minVolumeRatio: 0.8,
      minRangePosition: 0.3,
      maxEntryChasePct: 0.006,
      strongBreakoutMaxEntryChasePct: 0.018,
    },
  })
  assert(policy.momentum.minVolumeRatio === 1.2, 'breakout should require stronger volume')
  assert(policy.momentum.minRangePosition === 0.5, 'breakout should require upper intraday range')
  assert(policy.policy.strongBreakoutMaxEntryChasePct === 0.018, 'breakout may keep strong chase cap when market is calm')
}

{
  const policy = resolveAdaptiveExecutionPolicy({
    strategyMode: 'breakout',
    marketRiskLevel: 'high',
    base: {
      minVolumeRatio: 0.8,
      minRangePosition: 0.3,
      maxEntryChasePct: 0.006,
      strongBreakoutMaxEntryChasePct: 0.018,
    },
  })
  assert(policy.policy.maxEntryChasePct === 0.003, 'weak market should halve normal chase')
  assert(policy.policy.strongBreakoutMaxEntryChasePct === 0.009, 'weak market should halve strong breakout chase')
  assert(policy.momentum.minVolumeRatio === 1.5, 'weak market breakout should demand stronger volume confirmation')
}

{
  const policy = resolveAdaptiveExecutionPolicy({
    strategyMode: 'trend',
    marketRiskLevel: 'low',
    base: {
      minVolumeRatio: 0.8,
      minRangePosition: 0.3,
      maxEntryChasePct: 0.006,
      strongBreakoutMaxEntryChasePct: 0.018,
    },
  })
  assert(policy.momentum.minVolumeRatio === 0.75, 'trend mode should no longer expose the old static 0.8 volume floor')
  assert(policy.policy.maxEntryChasePct === 0.0045, 'trend mode should no longer expose the old static 0.6% chase cap')
  assert(policy.notes.includes('trend_balanced_confirmation'), 'trend mode should expose adaptive threshold provenance')
}

{
  const policy = resolveAdaptiveExecutionPolicy({
    strategyMode: 'trend',
    marketRiskLevel: 'low',
    l5Quality: {
      status: 'blocked',
      reasons: ['wide_l5_spread'],
      metrics: { spreadPct: 0.01 },
    },
    base: {
      minVolumeRatio: 0.8,
      minRangePosition: 0.3,
      maxEntryChasePct: 0.006,
      strongBreakoutMaxEntryChasePct: 0.018,
    },
  })
  assert(policy.policy.maxEntryChasePct === 0, 'blocked L5 quality should disable chasing')
  assert(policy.envelopeBlockReason === 'wide_l5_spread', 'blocked L5 quality should surface final envelope block reason')
}
