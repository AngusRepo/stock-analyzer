export interface ProjectedVolumeRatioInput {
  intradayTotalVolume: number | null | undefined
  avgDailyVolumeShares: number | null | undefined
  elapsedSessionFraction: number
  intradayVolumeLotSize?: number
}

export function normalizeShioajiTotalVolumeToShares(
  totalVolume: number | null | undefined,
  lotSize = 1000,
): number | null {
  const volume = Number(totalVolume ?? 0)
  const normalizedLotSize = Number(lotSize)
  if (!Number.isFinite(volume) || volume < 0) return null
  if (!Number.isFinite(normalizedLotSize) || normalizedLotSize <= 0) return volume
  return volume * normalizedLotSize
}

export function computeProjectedVolumeRatio(input: ProjectedVolumeRatioInput): number | null {
  const avgDailyVolumeShares = Number(input.avgDailyVolumeShares ?? 0)
  const elapsedSessionFraction = Number(input.elapsedSessionFraction)
  if (!Number.isFinite(avgDailyVolumeShares) || avgDailyVolumeShares <= 0) return null
  if (!Number.isFinite(elapsedSessionFraction) || elapsedSessionFraction <= 0) return null

  const intradayVolumeShares = normalizeShioajiTotalVolumeToShares(
    input.intradayTotalVolume,
    input.intradayVolumeLotSize,
  )
  if (intradayVolumeShares == null) return null

  return intradayVolumeShares / (avgDailyVolumeShares * elapsedSessionFraction)
}
