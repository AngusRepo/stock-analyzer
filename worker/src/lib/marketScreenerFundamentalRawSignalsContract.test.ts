import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync(join(process.cwd(), 'src/lib/marketScreener.ts'), 'utf8')
const start = source.indexOf('async function loadStrategyRawFundamentalSignals')
const end = source.indexOf('async function loadStrategyRawSectorRotationSignals', start)
assert(start >= 0 && end > start, 'loadStrategyRawFundamentalSignals block should exist')

const block = source.slice(start, end)

assert(
  block.includes('WITH requested_symbols AS'),
  'fundamental raw-signal loader should keep requested symbols even when only some fields exist',
)
assert(
  !block.includes('SELECT MAX(f2.available_date)'),
  'fundamental raw-signal loader must not select one latest row because daily valuation rows can null out ROE/EPS/revenue',
)

for (const field of [
  'revenue_growth_yoy',
  'gross_margin',
  'operating_margin',
  'roe',
  'eps',
  'pe',
  'pb',
  'dividend_yield',
]) {
  assert(
    block.includes(`latestNonNullFundamentalColumn('${field}')`),
    `fundamental raw-signal loader should request latest non-null ${field}`,
  )
}

assert(
  block.includes('AND f2.${column} IS NOT NULL') && block.includes('AS ${column}'),
  'fundamental raw-signal helper should fetch latest non-null values and preserve output aliases',
)
