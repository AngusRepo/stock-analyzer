export type DatedTrajectorySeries = {
  points: Array<{ date: string }>
}

export function buildFactorTrajectoryTimeline(series: DatedTrajectorySeries[]): string[] {
  return [...new Set(series.flatMap((item) => item.points.map((point) => point.date).filter(Boolean)))].sort()
}

export function factorTrajectoryPlaybackInterval(sessionCount: number): number {
  if (sessionCount <= 1) return 0
  return Math.round(Math.min(650, Math.max(120, 6_500 / (sessionCount - 1))))
}
