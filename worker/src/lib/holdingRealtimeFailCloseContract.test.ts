import * as fs from 'fs'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const exitTasks = fs.readFileSync('src/lib/paperExitTasks.ts', 'utf8')
const paperRoute = fs.readFileSync('src/routes/paper.ts', 'utf8')

assert(
  exitTasks.includes("reason: 'holding_authoritative_market_data_unavailable'"),
  'holding defense must persist a diagnostic event when authoritative broker market data is missing',
)
assert(
  exitTasks.includes("throw new Error('holding_authoritative_market_data_unavailable_all_positions')"),
  'all-position quote failure must fail the intraday scheduler instead of returning green',
)
assert(
  exitTasks.includes('holding_authoritative_market_data_unavailable_partial:'),
  'partial holding quote coverage must fail after processing covered positions',
)
assert(
  exitTasks.includes('contract_bypass_allowed: false'),
  'holding defense must prohibit contract or stale-source bypass',
)
assert(
  !exitTasks.includes("console.log('[Intraday] no intraday prices available')\n    return"),
  'holding quote failure must not use the legacy silent return',
)
assert(
  paperRoute.includes("'realtime_unavailable_eod_reference'"),
  'positions API must not present EOD fallback as a normal realtime price during market hours',
)
assert(
  paperRoute.includes("quote_status:     intradayMap.has(pos.symbol) ? 'fresh' as const : isMarketOpen ? 'unavailable'"),
  'positions API must expose explicit realtime quote availability',
)
