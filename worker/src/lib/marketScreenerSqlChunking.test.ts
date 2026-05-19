import { queryTopConceptTagsForSymbols } from './marketScreener'

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

  const rows = await queryTopConceptTagsForSymbols(db, symbols, 400)

  assert(rows.length === 1001, 'chunked concept tag query should return all rows')
  assert(calls.length === 26, '1001 symbols should be capped by the runtime D1 chunk size')
  assert(calls.every((call) => call.params.length <= 80), 'each taxonomy query binds two symbol chunks and stays below D1 limits')
  assert(calls.every((call) => call.sql.includes('finlab_taxonomy_tags')), 'query should read FinLab taxonomy first')
  assert(calls.every((call) => call.sql.includes("tag_type='concept'")), 'query should keep stock_tags concept overlay')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
