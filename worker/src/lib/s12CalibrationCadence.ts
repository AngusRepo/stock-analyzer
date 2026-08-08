export type S12CalibrationCadence = 'weekly' | 'monthly' | 'regime_shift'

export function resolveS12CalibrationCadence(
  requestedCadence: string | undefined,
  runDate: string,
): S12CalibrationCadence {
  if (requestedCadence === 'monthly' || requestedCadence === 'regime_shift' || requestedCadence === 'weekly') {
    return requestedCadence
  }
  if (requestedCadence !== 'auto') return 'weekly'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) return 'weekly'

  const runAt = new Date(`${runDate}T00:00:00Z`)
  if (!Number.isFinite(runAt.getTime())) return 'weekly'
  const previousDay = new Date(runAt)
  previousDay.setUTCDate(previousDay.getUTCDate() - 1)
  const followsFirstSaturday = previousDay.getUTCDay() === 6 && previousDay.getUTCDate() <= 7
  return followsFirstSaturday ? 'monthly' : 'weekly'
}
