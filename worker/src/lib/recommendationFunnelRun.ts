// The screener run whose funnel evidence explains a day's recommendations.
// The controller builds recommendations from the latest status='success' screener run of
// the date (ml-controller/services/recommendation_service.py _latest_screener_seed_symbols),
// and writeScreenerFunnel promotes exactly that run to the canonical head on success
// (a failed promotion resets the run to 'error'). Evidence must come from the same run,
// never from a later rerun that is still writing (its row starts as status='error') or
// that failed. A date without a successful run has no evidence (unknown).

export interface RecommendationFunnelRun {
  run_id: string
  /** false only if the canonical head was repointed away from the producer run. */
  is_canonical_head: boolean
}

export function screenerLogicalRunKey(date: string): string {
  return `screener:${date}:TW:production:market_screener`
}

// SEARCH idx_screener_funnel_runs_date (date=?) + PK lookup on canonical_run_heads.
export const RECOMMENDATION_FUNNEL_RUN_SQL = `
  SELECT r.run_id,
         EXISTS (
           SELECT 1 FROM canonical_run_heads h
            WHERE h.logical_run_key = ? AND h.run_id = r.run_id
         ) AS is_canonical_head
    FROM screener_funnel_runs r
   WHERE r.date = ?
     AND r.status = 'success'
   ORDER BY r.created_at DESC
   LIMIT 1
`

interface FirstRowStatement {
  bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> }
}

export async function resolveRecommendationFunnelRun(
  opsDb: { prepare(query: string): FirstRowStatement },
  date: string,
): Promise<RecommendationFunnelRun | null> {
  const row = await opsDb.prepare(RECOMMENDATION_FUNNEL_RUN_SQL)
    .bind(screenerLogicalRunKey(date), date)
    .first<{ run_id?: unknown; is_canonical_head?: unknown }>()
  const runId = String(row?.run_id ?? '').trim()
  if (!runId) return null
  return { run_id: runId, is_canonical_head: Number(row?.is_canonical_head ?? 0) === 1 }
}
