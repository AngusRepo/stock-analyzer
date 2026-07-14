import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync(new URL('./s12RuntimeBars.ts', import.meta.url), 'utf8')
const dailyContext = source.slice(
  source.indexOf('async function loadPreviousTradingDayContext'),
  source.indexOf('export function rollingBarsToOhlcvRows'),
)

assert(dailyContext.includes('cmd.open AS open'), 'S12 daily context must use raw tradable open')
assert(dailyContext.includes('cmd.close AS close'), 'S12 daily context must use raw tradable close')
assert(!dailyContext.includes('COALESCE(cmd.adj_'), 'S12 must not mix adjusted daily levels with raw intraday prices')
assert(source.includes('date >= tradeDate || !isTwSessionTime(bar.startMs)'), 'previous-session fallback must exclude after-hours bars')
