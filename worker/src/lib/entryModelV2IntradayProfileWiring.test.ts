import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')

assert(
  paperEntryTasks.includes("import { buildEntryPriceModelV2FromOhlcvPlan, buildVolumeProfileV2 } from './entryPriceModelV2'"),
  'intraday execution should import Entry Model V2 profile builder',
)

assert(
  paperEntryTasks.includes('rollingBarsToOhlcvRows') &&
    paperEntryTasks.includes('buildVolumeProfileV2(intradayRows'),
  'intraday execution should convert rolling bars into an intraday volume profile',
)

assert(
  paperEntryTasks.includes("anchorSource: 'intraday_volume_profile'") &&
    paperEntryTasks.includes("'entry_model_v2_intraday_profile'") &&
    paperEntryTasks.includes("'entry_model_v2_daily_proxy_fallback'"),
  'Entry Model V2 live path must prefer intraday profile and explicitly audit fallback',
)
