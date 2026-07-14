import assert from 'node:assert/strict'
import { pruneScreenerSeedRows } from './marketScreener'
import { sectorLeaderBonusBatch } from './sectorCorrelation'

type BoundCall = { sql: string; params: unknown[] }

void (async () => {
  const calls: BoundCall[] = []
  const existing = Array.from({ length: 200 }, (_, index) => ({ symbol: `S${index}` }))
  const pruneDb = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params })
          if (params.length > 40) throw new Error(`too many SQL variables: ${params.length}`)
          return {
            async all<T>() { return { results: existing as T[] } },
            async run() { return { success: true, meta: { changes: 1 } } },
          }
        },
      }
    },
    async batch(statements: any[]) {
      return statements.map(() => ({ success: true, meta: { changes: 1 } }))
    },
  } as unknown as D1Database

  const deleted = await pruneScreenerSeedRows(
    pruneDb,
    '2026-07-14',
    Array.from({ length: 160 }, (_, index) => `S${index}`),
  )
  assert.equal(deleted, 40)
  assert.equal(calls.some(call => call.sql.includes('NOT IN')), false)
  assert.equal(calls.every(call => call.params.length <= 40), true)

  const sectorCalls: BoundCall[] = []
  const sectorDb = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          sectorCalls.push({ sql, params })
          if (params.length > 40) throw new Error(`too many SQL variables: ${params.length}`)
          return {
            async all<T>() {
              if (sql.includes('FROM sector_leaders')) {
                return { results: [
                  { sector: 'Semiconductor', symbol: 'L1' },
                  { sector: 'Semiconductor', symbol: 'L2' },
                  { sector: 'Semiconductor', symbol: 'L3' },
                ] as T[] }
              }
              return { results: [] as T[] }
            },
          }
        },
      }
    },
  } as unknown as D1Database
  await sectorLeaderBonusBatch(
    sectorDb,
    Array.from({ length: 160 }, (_, index) => ({ symbol: `S${index}`, sector: 'Semiconductor' })),
    0.7,
    5,
  )
  const priceQueries = sectorCalls.filter(call => call.sql.includes('FROM stock_prices'))
  assert.equal(priceQueries.length, 5)
  assert.equal(priceQueries.every(call => call.params.length <= 40), true)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
