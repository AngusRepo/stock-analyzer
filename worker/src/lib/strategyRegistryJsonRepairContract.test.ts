import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync('migrations/0090_strategy_registry_json_repair.sql', 'utf8')

assert(migration.includes('stock_tech_s08_rsi2_risk_filter_v1'), 'repair must cover S8 filter registry JSON')
assert(migration.includes('stock_tech_s12_multitimeframe_smc_reclaim_v2'), 'repair must cover S12 V2 registry JSON')
assert(migration.includes('{"dsl":{"all":['), 'threshold DSL must remain valid quoted JSON')
assert(migration.includes('{"evidenceRequirements":['), 'S12 candidate policy must remain valid quoted JSON')
assert(!migration.includes("SET thresholds_json='{dsl:"), 'repair must not contain CLI-stripped JSON')

console.log('strategyRegistryJsonRepairContract tests passed')
