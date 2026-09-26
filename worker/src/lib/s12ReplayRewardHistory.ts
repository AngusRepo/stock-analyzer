import { CANONICAL_SELECTION_ROUNDTRIP_COST_BPS } from './canonicalSelectionLabels'
import { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'

// Preserved original hot SQL, also used by parity/index checks.
export const S12_REWARD_HOT_SQL = `
    SELECT o.signal_date AS date,
           MAX(date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date'))) AS outcome_known_date,
           COUNT(*) AS samples,
           SUM(CASE WHEN CAST(o.pnl_pct AS REAL) - (? / 10000.0) > 0 THEN 1 ELSE 0 END) AS hits,
           SUM(CAST(o.pnl_pct AS REAL) - (? / 10000.0)) AS reward_sum,
           AVG(CAST(o.pnl_pct AS REAL) - (? / 10000.0)) AS date_return
      FROM s12_replay_trade_outcomes o
     WHERE o.signal_date IS NOT NULL
       AND date(o.signal_date) <= date(?)
       AND o.sample_eligible=1
       AND o.source='s12_multisession_structure_replay_v3'
       AND o.pnl_pct IS NOT NULL
       AND json_extract(o.detail_json, '$.schema_version')='s12-replay-trade-outcome-v3'
       AND json_extract(o.detail_json, '$.observation_kind')='executed'
       AND json_extract(o.detail_json, '$.replay_diagnostics.replay_engine_signature')=?
       AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) IS NOT NULL
       AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
     GROUP BY o.signal_date
     ORDER BY o.signal_date
  `

export interface ReplayRewardDate {
  date: string
  outcome_known_date: string | null
  samples: number
  hits: number
  reward_sum: number
  date_return: number
}

export const S12_REPLAY_COLD_INTEGRITY_SQL = `      SELECT r.artifact_id FROM learning_retention_releases_v1 r
      LEFT JOIN s12_replay_cold_batches_v1 b ON b.artifact_id=r.artifact_id
      WHERE r.dataset_id='s12_replay_trade_outcomes' AND (b.artifact_id IS NULL
        OR b.source_checksum<>r.checksum OR b.row_count<>r.row_count OR b.cost_bps<>?)
      UNION ALL
      SELECT b.artifact_id FROM s12_replay_cold_batches_v1 b
      LEFT JOIN learning_retention_releases_v1 r ON r.artifact_id=b.artifact_id
      WHERE r.artifact_id IS NULL OR r.dataset_id<>'s12_replay_trade_outcomes'
        OR r.checksum<>b.source_checksum OR r.row_count<>b.row_count OR b.cost_bps<>?
`

/** One SQLite statement/snapshot: current hot evidence plus immutable cost-net cold sums.
 * No R2 downloads and no average-of-averages. A fee change requires rebuilding derived cold state.
 */
export async function loadS12ReplayRewardDates(db: D1Database, asOfDate: string): Promise<ReplayRewardDate[]> {
  const rows = (await db.prepare(`WITH invalid_history AS (
      ${S12_REPLAY_COLD_INTEGRITY_SQL}
    ), hot AS (${S12_REWARD_HOT_SQL}), pieces AS (
      SELECT date,outcome_known_date,samples,hits,reward_sum FROM hot
      UNION ALL
      SELECT c.signal_date,c.outcome_known_date,c.samples,c.hits,c.reward_sum
      FROM s12_replay_cold_rewards_v1 c
      JOIN s12_replay_cold_batches_v1 b ON b.artifact_id=c.artifact_id
      JOIN learning_retention_releases_v1 r ON r.artifact_id=b.artifact_id
        AND r.checksum=b.source_checksum AND r.row_count=b.row_count AND r.dataset_id='s12_replay_trade_outcomes'
      WHERE c.engine_signature=? AND date(c.signal_date)<=date(?) AND c.outcome_known_date<=date(?) AND b.cost_bps=?
    )
    SELECT date,MAX(outcome_known_date) outcome_known_date,SUM(samples) samples,SUM(hits) hits,
      SUM(reward_sum) reward_sum,SUM(reward_sum)*1.0/SUM(samples) date_return,0 history_invalid
    FROM pieces GROUP BY date
    UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,1 WHERE EXISTS(SELECT 1 FROM invalid_history)
    ORDER BY date`).bind(
      CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,
      CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,
      asOfDate,S12_REPLAY_ENGINE_SIGNATURE,asOfDate,
      S12_REPLAY_ENGINE_SIGNATURE,asOfDate,asOfDate,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,
    ).all<ReplayRewardDate & {history_invalid:number}>()).results ?? []
  if (rows.some(row => row.history_invalid)) throw new Error('retention_s12_reward_history_incomplete_or_cost_mismatch')
  return rows.map(({history_invalid:_,...row}) => row)
}
