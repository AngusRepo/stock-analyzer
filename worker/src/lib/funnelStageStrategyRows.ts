import type { Bindings } from '../types'
import { AUDIT_POINTER_SCHEMA, FunnelArchiveReader } from './screenerEvidenceResolver'

export interface FunnelStageStrategyRow {
  symbol: string
  strategy_id: string
}

export interface FunnelStageStrategyRows {
  rows: FunnelStageStrategyRow[]
  // Funnel items whose evidence is archived and could not be read back (no archive
  // binding, verification failure, chunk or byte budget): their strategies are missing from rows.
  archived_unresolved: number
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
  // Request-scoped: shares chunk reads with the other stage and the symbol slices.
  reader: FunnelArchiveReader | null = archiveEnv ? new FunnelArchiveReader(archiveEnv) : null,
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
  if (archived.length && archiveEnv && reader) {
    try {
      const restored = await reader.strategyIds(archived)
      // All-or-error: add only once every archived row of the stage was verified.
      for (const [index, strategyIds] of restored) for (const strategyId of strategyIds) add(archived[index].symbol, strategyId)
      archivedUnresolved = 0
    } catch (e) {
      console.warn('[funnelStageStrategyRows] archived evidence unavailable:', stage, e)
    }
  }
  return { rows: [...out.values()], archived_unresolved: archivedUnresolved }
}
