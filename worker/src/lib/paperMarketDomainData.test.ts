import assert from 'node:assert/strict'
import { batchGetAtrFromDomains, batchGetLatestPricesFromDomains } from './paperMarketDomainData'

function fakeDb(name: string, queries: string[], binds: unknown[][]): D1Database {
  return { prepare(sql: string) {
    queries.push(`${name}:${sql}`)
    return { bind(...values: unknown[]) { binds.push(values); return this }, async all<T>() {
      if (name === 'core') return { results: [{ id: 17, symbol: '2330' }] as unknown as T[] }
      if (/stock_prices/i.test(sql)) return { results: [{ stock_id: 17, price: 1010 }] as unknown as T[] }
      return { results: [{ stock_id: 17, atr14: 22.5 }] as unknown as T[] }
    } }
  } } as unknown as D1Database
}

async function main(): Promise<void> {
  const queries: string[] = []; const binds: unknown[][] = []
  const core = fakeDb('core', queries, binds); const market = fakeDb('market', queries, binds)
  assert.equal((await batchGetLatestPricesFromDomains(core, market, ['2330'], '2026-08-18')).get('2330'), 1010)
  assert.equal((await batchGetAtrFromDomains(core, market, ['2330'], '2026-08-18')).get('2330'), 22.5)
  assert(queries.some((q) => q.startsWith('core:') && /FROM stocks/i.test(q)))
  assert(queries.some((q) => q.startsWith('market:') && /stock_prices/i.test(q)))
  assert(queries.some((q) => q.startsWith('market:') && /technical_indicators/i.test(q)))
  assert(!queries.some((q) => /JOIN\s+stocks/i.test(q)))
  assert(binds.some((values) => values.filter((value) => value === '2026-08-18').length === 2))
  console.log('paper market domain split tests passed')
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
