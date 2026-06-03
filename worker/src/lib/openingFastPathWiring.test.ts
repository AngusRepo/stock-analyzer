import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const preTradePolicy = readFileSync('src/lib/preTradeExecutionPolicy.ts', 'utf8')

assert(
  paperEntryTasks.includes('ENTRY_MODEL_V2_OPENING_FAST_PATH_ENABLED') &&
    paperEntryTasks.includes('ENTRY_MODEL_V2_OPENING_FAST_PATH_MAX_MINUTES') &&
    paperEntryTasks.includes('ENTRY_MODEL_V2_OPENING_FAST_PATH_MAX_PREMIUM_PCT'),
  'intraday entry must expose explicit opening fast path env controls',
)

assert(
  paperEntryTasks.includes('minutesSinceTwMarketOpen') &&
    paperEntryTasks.includes('openingFastPath') &&
    paperEntryTasks.includes("'opening_fast_path_context'"),
  'runIntradayCheck must pass and audit opening fast path context',
)

assert(
  preTradePolicy.includes('openingFastPathIsActive') &&
    preTradePolicy.includes('canBypassOpeningTrendError') &&
    preTradePolicy.includes('opening_fast_path_entry'),
  'pre-trade policy must own the opening fast path decision instead of bypassing gates in paperEntryTasks',
)
