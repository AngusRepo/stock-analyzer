import {
  getSchedulerTaskPolicy,
  getNextRunApproxWithPolicy,
  nextTwTradingDate,
  parseTwseHolidayDates,
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

const parsedHolidays = parseTwseHolidayDates([
  { Name: "\u570b\u66c6\u65b0\u5e74\u958b\u59cb\u4ea4\u6613\u65e5", Date: "1150102", Description: "\u958b\u59cb\u4ea4\u6613" },
  { Name: "\u8fb2\u66c6\u6625\u7bc0\u524d\u6700\u5f8c\u4ea4\u6613\u65e5", Date: "1150211", Description: "" },
  { Name: "\u5e02\u5834\u7121\u4ea4\u6613", Date: "1150212", Description: "" },
  { Name: "\u52de\u52d5\u7bc0", Date: "1150501", Description: "\u4f9d\u898f\u5b9a\u653e\u50471\u65e5" },
], 2026)
assert(parsedHolidays.join(',') === '2026-02-12,2026-05-01', `TWSE holiday parser misclassified trading markers: ${parsedHolidays}`)
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
      task: 'evening-chain',
      cron: '0 13 * * 1-5',
      kv: kvWithHolidays(['2026-05-01']),
      nowTw: new Date('2026-05-01T08:00:00.000Z'),
    })
    assert(next === '5/4 21:00', `holiday/weekend next run should advance to next trading day, got ${next}`)
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
    const historicalSessionDb = {
      prepare() {
        return {
          bind(date: string) {
            return { async first() { return date === '2026-07-13' ? { present: 1 } : null } }
          },
        }
      },
    } as unknown as D1Database
    const next = await nextTwTradingDate(kvWithHolidays([]), '2026-07-09', historicalSessionDb)
    assert(next === '2026-07-13', `historical emergency closure must use actual session evidence, got ${next}`)
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
    const pausedGate = await shouldRunScheduledTask({
      task: 'optuna-queue',
      kv: {
        get: async (key: string) => key === 'scheduler:pause:global' ? 'incident-stop' : null,
      } as unknown as KVNamespace,
      nowTw: new Date('2026-05-01T08:00:00.000Z'),
    })
    assert(!pausedGate.shouldRun, 'global scheduler pause must stop all scheduled tasks')
    assert(pausedGate.reason.includes('global_pause:incident-stop'), 'global pause reason should be surfaced')
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
