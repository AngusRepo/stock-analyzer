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
              return {
                results: params.map((symbol) => ({ symbol, tag: `tag-${symbol}` })) as T[],
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
  assert(calls.length === 3, '1001 symbols with chunkSize=400 should issue 3 D1 queries')
  assert(calls.every((call) => call.params.length <= 400), 'each D1 query should stay below chunk size')
  assert(calls.every((call) => call.sql.includes("tag_type='concept'")), 'query should only read concept tags')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
