import { isTwIntradayTradingMinute } from './twMarketSession'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(isTwIntradayTradingMinute(new Date('2026-04-29T01:00:00.000Z')) === true, '09:00 TW should be inside intraday trading')
  assert(isTwIntradayTradingMinute(new Date('2026-04-29T05:30:00.000Z')) === true, '13:30 TW should still be inside intraday trading')
  assert(isTwIntradayTradingMinute(new Date('2026-04-29T05:31:00.000Z')) === false, '13:31 TW should not overwrite intraday trading logs')
  assert(isTwIntradayTradingMinute(new Date('2026-04-29T05:59:00.000Z')) === false, '13:59 TW should be heartbeat only, not intraday trading')
}
