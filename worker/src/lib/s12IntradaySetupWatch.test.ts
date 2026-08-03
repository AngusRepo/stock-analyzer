import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isS12SetupWatchState, isSetupWatchNearDemandZone } from './s12IntradaySetupWatch'

assert(isS12SetupWatchState('waiting_1h_demand_zone'))
assert(isS12SetupWatchState('waiting_15m_zone_touch'))
assert(!isS12SetupWatchState('invalidated'))

assert(isSetupWatchNearDemandZone({ demand_zone_low: 98, demand_zone_high: 100 }, 101.5, 0.018))
assert(!isSetupWatchNearDemandZone({ demand_zone_low: 98, demand_zone_high: 100 }, 105, 0.018))
assert(isSetupWatchNearDemandZone({ demand_zone_low: null, demand_zone_high: null }, 100, 0.018))

const source = fs.readFileSync('src/lib/s12IntradaySetupWatch.ts', 'utf8')
assert(source.includes('FROM daily_recommendations dr'))
assert(source.includes("json_extract(dr.score_components, '$.eligibleForAllocation')"))
assert(source.includes("<> 'formal_ml_gate_filtered'"))
assert(source.includes('FROM pending_buy_items pbi'))
assert(source.includes('JOIN pending_buy_runs pbr ON pbr.id = pbi.run_id'))
assert(source.includes("NOT IN ('filled', 'skipped', 'cancelled', 'expired', 'rejected')"))
assert(source.includes('FROM watchlist explicit_watch'))
assert(source.includes('JOIN stocks watched_stock ON watched_stock.id = explicit_watch.stock_id'))
assert(source.includes('LIMIT 50'))
assert(source.includes('.bind(today, today, today)'))

console.log('s12IntradaySetupWatch tests passed')
