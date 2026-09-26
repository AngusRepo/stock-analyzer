import { S12_REPLAY_COLD_INTEGRITY_SQL } from './s12ReplayRewardHistory'
import { CANONICAL_SELECTION_ROUNDTRIP_COST_BPS } from './canonicalSelectionLabels'

/** Run the existing trusted status SQL against a bounded signal-day projection in one snapshot. */
export async function queryReplayStatusSymbols(db: D1Database, signalDate: string, sql: string, params: unknown[])
  : Promise<{results:Array<{symbol:string}>}> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signalDate) || !sql.includes('s12_replay_trade_outcomes'))
    throw new Error('retention_s12_replay_status_query_invalid')
  const rows = (await db.prepare(`WITH invalid_history AS (${S12_REPLAY_COLD_INTEGRITY_SQL}),
    s12_replay_status AS (
      SELECT symbol,signal_date,sample_eligible,source,detail_json FROM s12_replay_trade_outcomes WHERE signal_date=?
      UNION ALL
      SELECT c.symbol,c.signal_date,c.sample_eligible,c.source,c.status_json FROM s12_replay_cold_identities_v1 c
      JOIN s12_replay_cold_batches_v1 b ON b.artifact_id=c.artifact_id
      JOIN learning_retention_releases_v1 r ON r.artifact_id=b.artifact_id AND r.checksum=b.source_checksum
        AND r.row_count=b.row_count AND r.dataset_id='s12_replay_trade_outcomes'
      WHERE c.signal_date=?
    ), selected AS (${sql.replaceAll('s12_replay_trade_outcomes','s12_replay_status')})
    SELECT symbol,0 history_invalid FROM selected
    UNION ALL SELECT NULL,1 WHERE EXISTS(SELECT 1 FROM invalid_history)
    ORDER BY symbol`).bind(CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,signalDate,signalDate,...params)
    .all<{symbol:string;history_invalid:number}>()).results ?? []
  if (rows.some(row => row.history_invalid)) throw new Error('retention_s12_replay_status_history_incomplete')
  return {results:rows.map(({symbol}) => ({symbol}))}
}
