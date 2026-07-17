import assert from 'node:assert/strict'
import { isS12SetupWatchState, isSetupWatchNearDemandZone } from './s12IntradaySetupWatch'

assert(isS12SetupWatchState('waiting_1h_demand_zone'))
assert(isS12SetupWatchState('waiting_15m_zone_touch'))
assert(!isS12SetupWatchState('invalidated'))

assert(isSetupWatchNearDemandZone({ demand_zone_low: 98, demand_zone_high: 100 }, 101.5, 0.018))
assert(!isSetupWatchNearDemandZone({ demand_zone_low: 98, demand_zone_high: 100 }, 105, 0.018))
assert(isSetupWatchNearDemandZone({ demand_zone_low: null, demand_zone_high: null }, 100, 0.018))

console.log('s12IntradaySetupWatch tests passed')
