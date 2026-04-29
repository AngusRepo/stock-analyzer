import { selectSchedulerDisplayLogs, type SchedulerDisplayLogCandidate } from './schedulerStatus'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const logs: SchedulerDisplayLogCandidate[] = [
  {
    date: '2026-04-29',
    log: {
      task: 'intraday-check',
      status: 'skipped',
      summary: 'heartbeat ok; state=empty',
      duration_ms: 20,
      timestamp: '2026-04-29T05:30:00.000Z',
    },
  },
  {
    date: '2026-04-28',
    log: {
      task: 'intraday-check',
      status: 'success',
      summary: 'buy placed',
      duration_ms: 120,
      timestamp: '2026-04-28T02:10:00.000Z',
    },
  },
]

{
  const display = selectSchedulerDisplayLogs(logs)
  assert(display.lastAttempt?.timestamp === '2026-04-29T05:30:00.000Z', 'lastAttempt must show the newest cron attempt even when skipped')
  assert(display.lastEffective?.timestamp === '2026-04-28T02:10:00.000Z', 'lastEffective should preserve the latest non-skipped run')
}
