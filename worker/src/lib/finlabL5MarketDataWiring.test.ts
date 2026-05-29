import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const paperExecutionEvents = readFileSync('src/lib/paperExecutionEvents.ts', 'utf8')

assert(
  paperEntryTasks.includes('fetchFinLabL5MarketDataQuotes'),
  'intraday execution must fetch FinLab/Sinopac L5 market data for pending candidates',
)
assert(
  paperEntryTasks.includes('quoteQualityFromL5'),
  'intraday execution must evaluate L5 quote quality before formal execution promotion',
)
assert(
  paperEntryTasks.includes('resolveAdaptiveExecutionPolicy'),
  'intraday execution must resolve adaptive execution thresholds by strategy and market state',
)
assert(
  paperEntryTasks.includes("'finlab_l5_market_data'"),
  'intraday execution must persist FinLab L5 market-data events',
)
assert(
  paperExecutionEvents.includes("'finlab_l5_market_data'"),
  'paper execution event contract must allow FinLab L5 market-data events',
)
