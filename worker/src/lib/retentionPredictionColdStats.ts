// Running totals of archived Learning `predictions`, per (stock_id, model_name), written in the
// same D1 batch as the exact delete. verify_service period='all' (model_accuracy /
// trade_performance) adds these to its hot aggregates instead of downloading every R2 chunk each
// night. Each column is one SQL aggregate of the original rows; ml-controller
// services/retention_prediction_reads.py PREDICTION_COLD_STATS_EXPRESSIONS repeats them for the hot
// side and must stay identical (retentionPredictionColdStats.test.ts compares both lists).

const D = 'p.direction_correct IN (0,1)'
/** ml-controller services/no_lookahead_audit.py CANONICAL_LABEL_VERSION (compared by test). */
export const CANONICAL_PREDICTION_LABEL_VERSION = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
const T = 'p.trade_pnl_pct IS NOT NULL'

/** kind: count/sum add up, max/min keep the extreme; sums stay NULL until a row contributes. */
export const PREDICTION_COLD_STATS_COLUMNS: ReadonlyArray<readonly [string, 'count' | 'sum' | 'max' | 'min', string]> = [
  // model_accuracy 'all': rows with direction_correct IN (0,1)
  ['d_total', 'count', `SUM(CASE WHEN ${D} THEN 1 ELSE 0 END)`],
  ['d_correct', 'count', `SUM(CASE WHEN ${D} THEN p.direction_correct ELSE 0 END)`],
  ['d_err_sum', 'sum', `SUM(CASE WHEN ${D} THEN p.price_error_pct END)`],
  ['d_err_n', 'count', `COUNT(CASE WHEN ${D} THEN p.price_error_pct END)`],
  ['d_low_total', 'count', `SUM(CASE WHEN ${D} AND p.market_risk_level IN ('green','yellow') THEN 1 ELSE 0 END)`],
  ['d_low_correct', 'count', `SUM(CASE WHEN ${D} AND p.market_risk_level IN ('green','yellow') THEN p.direction_correct ELSE 0 END)`],
  ['d_high_total', 'count', `SUM(CASE WHEN ${D} AND p.market_risk_level IN ('red','black') THEN 1 ELSE 0 END)`],
  ['d_high_correct', 'count', `SUM(CASE WHEN ${D} AND p.market_risk_level IN ('red','black') THEN p.direction_correct ELSE 0 END)`],
  ['d_win_sum', 'sum', `SUM(CASE WHEN ${D} AND p.direction_correct=1 THEN p.actual_return_pct END)`],
  ['d_win_n', 'count', `COUNT(CASE WHEN ${D} AND p.direction_correct=1 THEN p.actual_return_pct END)`],
  ['d_loss_sum', 'sum', `SUM(CASE WHEN ${D} AND p.direction_correct=0 THEN p.actual_return_pct END)`],
  ['d_loss_n', 'count', `COUNT(CASE WHEN ${D} AND p.direction_correct=0 THEN p.actual_return_pct END)`],
  ['d_pnl_sum', 'sum', `SUM(CASE WHEN ${D} THEN p.trade_pnl_pct END)`],
  ['d_pnl_n', 'count', `COUNT(CASE WHEN ${D} THEN p.trade_pnl_pct END)`],
  ['d_r_sum', 'sum', `SUM(CASE WHEN ${D} THEN p.trade_pnl_r END)`],
  ['d_r_n', 'count', `COUNT(CASE WHEN ${D} THEN p.trade_pnl_r END)`],
  ['d_gross_profit', 'sum', `SUM(CASE WHEN ${D} THEN CASE WHEN p.trade_pnl_pct > 0 THEN p.trade_pnl_pct ELSE 0 END END)`],
  ['d_gross_loss', 'sum', `SUM(CASE WHEN ${D} THEN CASE WHEN p.trade_pnl_pct < 0 THEN ABS(p.trade_pnl_pct) ELSE 0 END END)`],
  ['d_hit_target', 'count', `SUM(CASE WHEN ${D} AND (p.trade_outcome='hit_target1' OR p.trade_outcome='hit_target2') THEN 1 ELSE 0 END)`],
  ['d_hit_stop', 'count', `SUM(CASE WHEN ${D} AND p.trade_outcome='hit_stop' THEN 1 ELSE 0 END)`],
  // trade_performance 'all': rows with trade_pnl_pct IS NOT NULL
  ['t_total', 'count', `SUM(CASE WHEN ${T} THEN 1 ELSE 0 END)`],
  ['t_wins', 'count', `SUM(CASE WHEN p.trade_pnl_pct > 0 THEN 1 ELSE 0 END)`],
  ['t_losses', 'count', `SUM(CASE WHEN p.trade_pnl_pct < 0 THEN 1 ELSE 0 END)`],
  ['t_pnl_sum', 'sum', 'SUM(p.trade_pnl_pct)'],
  ['t_win_sum', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct > 0 THEN p.trade_pnl_pct END)'],
  ['t_loss_sum', 'sum', 'SUM(CASE WHEN p.trade_pnl_pct < 0 THEN p.trade_pnl_pct END)'],
  ['t_max', 'max', 'MAX(p.trade_pnl_pct)'],
  ['t_min', 'min', 'MIN(p.trade_pnl_pct)'],
  ['t_gross_profit', 'sum', `SUM(CASE WHEN ${T} THEN CASE WHEN p.trade_pnl_pct > 0 THEN p.trade_pnl_pct ELSE 0 END END)`],
  ['t_gross_loss', 'sum', `SUM(CASE WHEN ${T} THEN CASE WHEN p.trade_pnl_pct < 0 THEN ABS(p.trade_pnl_pct) ELSE 0 END END)`],
  ['t_r_sum', 'sum', `SUM(CASE WHEN ${T} THEN p.trade_pnl_r END)`],
  ['t_r_n', 'count', `COUNT(CASE WHEN ${T} THEN p.trade_pnl_r END)`],
  ['t_hit_t1', 'count', `SUM(CASE WHEN ${T} AND p.trade_outcome='hit_target1' THEN 1 ELSE 0 END)`],
  ['t_hit_t2', 'count', `SUM(CASE WHEN ${T} AND p.trade_outcome='hit_target2' THEN 1 ELSE 0 END)`],
  ['t_hit_stop', 'count', `SUM(CASE WHEN ${T} AND p.trade_outcome='hit_stop' THEN 1 ELSE 0 END)`],
  ['t_expired', 'count', `SUM(CASE WHEN ${T} AND p.trade_outcome='expired' THEN 1 ELSE 0 END)`],
  ['t_mfe_sum', 'sum', `SUM(CASE WHEN ${T} THEN p.max_favorable_pct END)`],
  ['t_mfe_n', 'count', `COUNT(CASE WHEN ${T} THEN p.max_favorable_pct END)`],
  ['t_mae_sum', 'sum', `SUM(CASE WHEN ${T} THEN p.max_adverse_pct END)`],
  ['t_mae_n', 'count', `COUNT(CASE WHEN ${T} THEN p.max_adverse_pct END)`],
  // no_lookahead_audit canonical_prediction_label: violations among archived rows (the audit adds them).
  ['label_v4_violations', 'count', `SUM(CASE WHEN p.verification_label_schema_version='${CANONICAL_PREDICTION_LABEL_VERSION}' AND (p.prediction_date IS NULL OR p.verification_label_end_date < p.prediction_date OR p.verification_label_known_date <= p.prediction_date) THEN 1 ELSE 0 END)`],
]

function merge(name: string, kind: string): string {
  if (kind === 'count') return `${name}=${name}+excluded.${name}`
  const both = kind === 'sum' ? `${name}+excluded.${name}` : `${kind}(${name},excluded.${name})`
  return `${name}=CASE WHEN ${name} IS NULL THEN excluded.${name} WHEN excluded.${name} IS NULL THEN ${name} ELSE ${both} END`
}

/** Runs BEFORE the exact DELETE in the same D1 batch; a rolled-back delete rolls these totals back too. */
export function predictionColdStatsStatement(db: D1Database, rows: Record<string, unknown>[]): D1PreparedStatement {
  const keys = rows.map((row) => row.__cursor_key)
  if (!keys.length || keys.some((key) => !Number.isSafeInteger(key))) throw new Error('retention_prediction_cold_stats_identity_invalid')
  const names = PREDICTION_COLD_STATS_COLUMNS.map(([name]) => name)
  return db.prepare(`INSERT INTO prediction_cold_stats_v1 (stock_id, model_name, ${names.join(', ')}, archived_rows)
    SELECT p.stock_id, p.model_name, ${PREDICTION_COLD_STATS_COLUMNS.map(([, , sql]) => sql).join(', ')}, COUNT(*)
      FROM predictions p
     WHERE p.rowid IN (SELECT value FROM json_each(?))
     GROUP BY p.stock_id, p.model_name
    ON CONFLICT(stock_id, model_name) DO UPDATE SET
      ${PREDICTION_COLD_STATS_COLUMNS.map(([name, kind]) => merge(name, kind)).join(',\n      ')},
      archived_rows=archived_rows+excluded.archived_rows,
      updated_at=CURRENT_TIMESTAMP`).bind(JSON.stringify(keys))
}
