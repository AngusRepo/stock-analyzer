import { queryTopTaxonomyTagsForSymbols } from './marketScreener'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

type PreparedCall = { sql: string; params: unknown[] }

function makeDb() {
  const calls: PreparedCall[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params })
          if (params.length > 450) {
            throw new Error(`too many SQL variables in test: ${params.length}`)
          }
          return {
            async all<T>() {
              const uniqueSymbols = [...new Set(params.map((symbol) => String(symbol)))]
              return {
                results: uniqueSymbols.map((symbol) => ({ symbol, tag: `tag-${symbol}`, tag_type: 'industry_theme' })) as T[],
              }
            },
          }
        },
      }
    },
  } as unknown as D1Database
  return { db, calls }
}

void (async () => {
  const symbols = Array.from({ length: 1001 }, (_, index) => `S${index}`)
  const { db, calls } = makeDb()

  const rows = await queryTopTaxonomyTagsForSymbols(db, symbols, 400)

  assert(rows.length === 1001, 'chunked concept tag query should return all rows')
  assert(calls.length === 26, '1001 symbols should be capped by the runtime D1 chunk size')
  assert(calls.every((call) => call.params.length <= 40), 'each FinLab taxonomy query binds one bounded symbol chunk')
  assert(calls.every((call) => call.sql.includes('finlab_taxonomy_tags')), 'query should read FinLab taxonomy first')
  assert(calls.every((call) => !call.sql.includes('stock_tags')), 'query must use FinLab as the sole taxonomy owner')

  const dated = makeDb()
  await queryTopTaxonomyTagsForSymbols(dated.db, symbols.slice(0, 41), 400, '2026-07-24')
  assert(dated.calls.length === 2, 'as-of taxonomy query must preserve bounded chunking')
  assert(dated.calls.every((call) => call.sql.includes('date(as_of_date) <= date(?)')), 'FinLab taxonomy must use as-of date')
  assert(dated.calls.every((call) => call.params.filter((param) => param === '2026-07-24').length === 1), 'the sole FinLab taxonomy branch must bind its decision date once')
  assert(dated.calls.every((call) => call.params.length <= 41), 'as-of taxonomy query must stay below the bounded D1 variable budget')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
