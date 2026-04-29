import { computeProjectedVolumeRatio, normalizeShioajiTotalVolumeToShares } from './preTradeMomentum'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const shares = normalizeShioajiTotalVolumeToShares(8428)
  assert(shares === 8_428_000, 'Shioaji total_volume should normalize lots to shares by default')
}

{
  const ratio = computeProjectedVolumeRatio({
    intradayTotalVolume: 8428,
    avgDailyVolumeShares: 19_126_950.4,
    elapsedSessionFraction: 0.32,
  })
  assert(ratio != null && ratio > 1.3 && ratio < 1.4, 'projected volume ratio should compare shares to shares')
}

{
  const ratio = computeProjectedVolumeRatio({
    intradayTotalVolume: 129,
    avgDailyVolumeShares: 820_163.75,
    elapsedSessionFraction: 0.32,
  })
  assert(ratio != null && ratio > 0.48 && ratio < 0.5, 'thin volume should remain below normal threshold')
}

{
  const ratio = computeProjectedVolumeRatio({
    intradayTotalVolume: 1000,
    avgDailyVolumeShares: 0,
    elapsedSessionFraction: 0.5,
  })
  assert(ratio == null, 'missing average volume should not fabricate a ratio')
}
