import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const bindings = readFileSync('src/types.ts', 'utf8')
const wrangler = readFileSync('wrangler.toml', 'utf8')

for (const envName of [
  'EXECUTION_WATCH_POOL_SIZE',
  'EXECUTION_WATCH_MIN_ML_EDGE',
  'EXECUTION_WATCH_MIN_FINAL_SCORE',
  'EXECUTION_WATCH_RISK_MULTIPLIER',
  'EXECUTION_CLOSE_WINDOW_MIN_VOLUME_RATIO',
  'FINLAB_L5_MARKET_DATA_ENABLED',
  'FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN',
  'FINLAB_L5_MAX_QUOTE_AGE_MS',
  'FINLAB_L5_MAX_SPREAD_PCT',
  'FINLAB_L5_MIN_DEPTH_LEVELS',
  'FINLAB_L5_MIN_TOP_ASK_VOLUME',
  'FINLAB_L5_MIN_ORDER_BOOK_IMBALANCE',
  'FINLAB_L5_ENVELOPE_GUARD_ENABLED',
  'INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED',
  'INTRADAY_TECHNICAL_DISTRIBUTION_SKIP_MIN_BARS',
]) {
  assert(bindings.includes(`${envName}?: string`), `${envName} must be declared on Worker Bindings`)
  assert(wrangler.includes(`${envName} = `), `${envName} must have an explicit production default in wrangler.toml`)
}
