import { loadRuntimeThemeSignals } from './multiSourceThemeEvidence'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const calls: { sql?: string; params?: unknown[] } = {}
const db = {
  prepare(sql: string) {
    calls.sql = sql
    return {
      bind(...params: unknown[]) {
        calls.params = params
        return {
          async all<T>() {
            return {
              results: [{
                concept: 'AI',
                score: 3,
                sentiment_avg: 0.4,
                source: 'finlab_taxonomy',
                evidence_count: 2,
                top_titles: JSON.stringify(['AI supply chain']),
                allowed_use: 'context',
                decision_effect: 'score_context',
              }] as T[],
            }
          },
        }
      },
    }
  },
} as unknown as D1Database

async function main(): Promise<void> {
  const rows = await loadRuntimeThemeSignals(db, '2026-05-24')

  assert(calls.sql?.includes("date >= date(?, '-14 days')"), 'runtime theme signals must reject stale evidence older than 14 days')
  assert(JSON.stringify(calls.params) === JSON.stringify(['2026-05-24', '2026-05-24']), 'theme signal query should bind window anchor and decision date')
  assert(rows.length === 1, 'fresh runtime theme signal should still be accepted')
  assert(rows[0].concept === 'AI', 'theme signal concept should be preserved')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
