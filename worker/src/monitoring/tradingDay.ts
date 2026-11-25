import { recordedClosure } from '../lib/twRecordedClosure'
import { addDays, memoized, twDate, type MonitoringEnv } from './env'

type CalendarEnv = Pick<MonitoringEnv, 'KV' | 'MEMO'>
/** A day's closure changes at most once (an ad-hoc typhoon closure): asked of KV once per 5 minutes, not per poll. */
export const TRADING_DAY_MEMO_TTL_S = 300

/** Trading day = the main Worker's recorded-closure reader (weekend, holiday:* incl. a typhoon ad-hoc
 * closure, cached TWSE schedule / ad-hoc check). KV reads only, never TWSE. */
export async function isTradingDay(env: CalendarEnv, date: string): Promise<boolean> {
  return memoized(env.MEMO, `trading-day|${date}`, TRADING_DAY_MEMO_TTL_S, async () => !(await recordedClosure(env.KV, date)))
}

const MAX_WALK_DAYS = 15

export async function previousTradingDay(env: CalendarEnv, date: string): Promise<string | null> {
  for (let offset = 1; offset <= MAX_WALK_DAYS; offset++) {
    const candidate = addDays(date, -offset)
    if (await isTradingDay(env, candidate)) return candidate
  }
  return null
}

export type BusinessDates = {
  /** Business date X: the requested date, else today (TW) when it trades, else the last trading day. */
  x: string
  xTrading: boolean
  /** X−1: the trading day before X. */
  xPrev: string | null
  today: string
}

export async function resolveBusinessDates(env: CalendarEnv, nowMs: number, requested?: string | null): Promise<BusinessDates> {
  const today = twDate(nowMs)
  if (requested) {
    return { x: requested, xTrading: await isTradingDay(env, requested), xPrev: await previousTradingDay(env, requested), today }
  }
  const x = (await isTradingDay(env, today)) ? today : await previousTradingDay(env, today)
  if (!x) return { x: today, xTrading: false, xPrev: null, today }
  return { x, xTrading: true, xPrev: await previousTradingDay(env, x), today }
}
