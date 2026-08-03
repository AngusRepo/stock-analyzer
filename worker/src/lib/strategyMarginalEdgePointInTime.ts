export const STRATEGY_MARGINAL_EDGE_POINT_IN_TIME_HEAD_SQL = `
  SELECT run_id
    FROM strategy_marginal_edge_runs_v4
   WHERE status='promoted' AND as_of_date < ?
   ORDER BY as_of_date DESC, created_at DESC, run_id DESC
   LIMIT 1
`

/**
 * Loads only evidence known before the requested screener date. Same-day
 * strategy outcomes and promotion decisions are deliberately excluded.
 */
export async function loadPromotedStrategyMarginalEdgeWeightsBefore(
  db: D1Database,
  strategyIds: readonly string[],
  knowledgeCutoffDate: string,
): Promise<{ runId: string; weights: Record<string, number> } | null> {
  const head = await db.prepare(STRATEGY_MARGINAL_EDGE_POINT_IN_TIME_HEAD_SQL)
    .bind(knowledgeCutoffDate)
    .first<{ run_id?: string }>()
  if (!head?.run_id) return null

  const rows = await db.prepare(`
    SELECT strategy_id, production_weight_raw
      FROM strategy_marginal_edge_v4
     WHERE run_id=?
  `).bind(head.run_id).all<{ strategy_id: string; production_weight_raw: number | string }>()
  const raw = new Map<string, number>()
  for (const row of rows.results ?? []) {
    const weight = Math.max(0, Number(row.production_weight_raw) || 0)
    raw.set(row.strategy_id, (raw.get(row.strategy_id) ?? 0) + weight)
  }
  const total = [...raw.values()].reduce((sum, value) => sum + value, 0)
  const weights = Object.fromEntries(
    [...new Set(strategyIds)].map((strategyId) => [
      strategyId,
      total > 0 ? (raw.get(strategyId) ?? 0) / total : 0,
    ]),
  )
  return { runId: head.run_id, weights }
}
