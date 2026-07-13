import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')

assert(source.includes('s12_market_data_unavailable'), 'missing quote cycles must persist a current S12 data error')
assert(source.includes('authoritative_market_data_unavailable'), 'pending buy must expose authoritative market-data outage')
assert(source.includes("throw new Error('intraday_authoritative_market_data_unavailable_all_symbols')"), 'all-symbol quote outage must fail scheduler execution')
assert(!source.includes('if (priceMap.size === 0) return'), 'quote outage must not silently return HTTP 200')
assert(source.includes('contract_bypass_allowed: false'), 'market-data outage must not re-enable a legacy entry owner')

console.log('intraday market-data fail-closed tests passed')
