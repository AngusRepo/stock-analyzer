import {
  getSchedulerTaskPolicy,
  getNextRunApproxWithPolicy,
  shouldRunScheduledTask,
} from './schedulerPolicy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function kvWithHolidays(holidays: string[]): KVNamespace {
  const set = new Set(holidays)
  return {
    get: async (key: string) => set.has(key.replace('holiday:', '')) ? '1' : null,
  } as unknown as KVNamespace
}

void (async () => {
  {
    const policy = getSchedulerTaskPolicy('update')
    assert(policy.kind === 'trading_day', 'market data update must be holiday-gated')

    const gate = await shouldRunScheduledTask({
      task: 'update',
      kv: kvWithHolidays(['2026-05-01']),
      nowTw: new Date('2026-05-01T08:00:00.000Z'),
    })
    assert(!gate.shouldRun, 'trading-day task must skip TW holiday')
    assert(gate.reason.includes('holiday'), 'skip reason should explain holiday')
  }

  {
    const next = await getNextRunApproxWithPolicy({
      task: 'update',
      cron: '15 9 * * 1-5',
      kv: kvWithHolidays(['2026-05-01']),
      nowTw: new Date('2026-05-01T08:00:00.000Z'),
    })
    assert(next === '5/4 17:15', `holiday/weekend next run should advance to next trading day, got ${next}`)
  }

  {
    const next = await getNextRunApproxWithPolicy({
      task: 'intraday-rescore',
      cron: '0 2,3,4 * * 1-5 + 30 4 * * 1-5',
      kv: kvWithHolidays(['2026-05-01']),
      nowTw: new Date('2026-05-01T08:00:00.000Z'),
    })
    assert(next === '5/4 10:00', `composite intraday cron should skip holiday/weekend and choose earliest leg, got ${next}`)
  }

  {
    const queueGate = await shouldRunScheduledTask({
      task: 'optuna-queue',
      kv: kvWithHolidays(['2026-05-01']),
      nowTw: new Date('2026-05-01T08:00:00.000Z'),
    })
    assert(queueGate.shouldRun, 'queue processor is not a trading-day market-data task')
  }

  {
    const next = await getNextRunApproxWithPolicy({
      task: 'retrain',
      cron: 'first sunday of month 02:00 taipei',
      kv: kvWithHolidays([]),
      nowTw: new Date('2026-05-01T08:00:00.000Z'),
    })
    assert(next === '5/3 02:00', `monthly groc schedule should show first Sunday TW, got ${next}`)
  }

  {
    const next = await getNextRunApproxWithPolicy({
      task: 'monthly-optuna',
      cron: 'first saturday of month 16:00',
      kv: kvWithHolidays([]),
      nowTw: new Date('2026-05-01T08:00:00.000Z'),
    })
    assert(next === '5/3 00:00', `UTC groc monthly schedule should display as TW wall time, got ${next}`)
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
