import type { Bindings } from '../types'
import { AUDIT_POINTER_SCHEMA, type FunnelArchiveChunkCache, visitArchivedFunnelEvidence } from './screenerEvidenceResolver'

export interface FunnelStageStrategyRow {
  symbol: string
  strategy_id: string
}

export interface FunnelStageStrategyRows {
  rows: FunnelStageStrategyRow[]
  // Funnel items whose evidence is archived and could not be read back (no archive
  // binding, verification failure, chunk limit): their strategies are missing from rows.
  archived_unresolved: number
}

function evidenceStrategyIds(evidence: Record<string, any>): string[] {
  const ids = evidence?.strategy_pool_ids ?? evidence?.strategy_ids
  // Same as the SQL json_each: array elements, object values, or the scalar itself.
  return (Array.isArray(ids) ? ids : ids && typeof ids === 'object' ? Object.values(ids) : [ids])
    .filter((value) => typeof value === 'string' || typeof value === 'number').map(String)
}

/**
 * Distinct (symbol, strategy_id) of one funnel stage. Strategy ids are projected in SQL;
 * only rows whose evidence the retention job replaced with an audit pointer come back with
 * that (small) pointer, and their ids are read from the verified R2 pre-image. Without the
 * archive, or when it cannot be verified, those rows are counted in archived_unresolved.
 */
export async function loadFunnelStageStrategyRows(
  opsDb: Bindings['DB'],
  archiveEnv: Pick<Bindings, 'DB' | 'ARTIFACTS'> | null,
  runId: string,
  stage: string,
  chunks: FunnelArchiveChunkCache = new Map(),
): Promise<FunnelStageStrategyRows> {
  const { results } = await opsDb.prepare(`
    SELECT DISTINCT i.id, i.run_id, i.stage, i.symbol, CAST(strategy.value AS TEXT) AS strategy_id,
           CASE WHEN strategy.type IS NULL THEN i.evidence END AS archived_evidence
      FROM screener_funnel_items i
      LEFT JOIN json_each(
        CASE
          WHEN json_valid(i.evidence) THEN COALESCE(
            json_extract(i.evidence, '$.strategy_pool_ids'),
            json_extract(i.evidence, '$.strategy_ids'),
            json('[]')
          )
          ELSE json('[]')
        END
      ) AS strategy
     WHERE i.run_id = ?
       AND i.stage = ?
       AND i.decision IN ('selected', 'pass', 'observe')
       AND (
         strategy.value IS NOT NULL
         OR (strategy.type IS NULL AND json_valid(i.evidence)
             AND json_extract(i.evidence, '$.schema_version') = ?)
       )
  `).bind(runId, stage, AUDIT_POINTER_SCHEMA).all<any>().catch(() => ({ results: [] as any[] }))
  const out = new Map<string, FunnelStageStrategyRow>()
  const add = (symbol: unknown, strategyId: unknown) => {
    const cleanSymbol = String(symbol ?? '').trim()
    const cleanStrategy = String(strategyId ?? '').trim()
    if (cleanSymbol && cleanStrategy) out.set(`${cleanSymbol}\u0000${cleanStrategy}`, { symbol: cleanSymbol, strategy_id: cleanStrategy })
  }
  const archived: any[] = []
  for (const row of results ?? []) {
    if (row.archived_evidence != null) archived.push({ ...row, evidence: row.archived_evidence })
    else if (row.strategy_id != null) add(row.symbol, row.strategy_id)
  }
  let archivedUnresolved = archived.length
  if (archived.length && archiveEnv) {
    try {
      const restored: Array<[unknown, string[]]> = []
      await visitArchivedFunnelEvidence(archiveEnv, archived, (_index, row, _text, evidence) => {
        restored.push([row.symbol, evidenceStrategyIds(evidence)])
      }, { chunks })
      // All-or-error: add only once every archived row of the stage was verified.
      for (const [symbol, strategyIds] of restored) for (const strategyId of strategyIds) add(symbol, strategyId)
      archivedUnresolved = 0
    } catch (e) {
      console.warn('[funnelStageStrategyRows] archived evidence unavailable:', stage, e)
    }
  }
  return { rows: [...out.values()], archived_unresolved: archivedUnresolved }
}
