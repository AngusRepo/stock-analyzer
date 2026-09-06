export type IpoModelMetrics = {
  rank_ic: number | null; rmse: number; proxy_net_return: number; invested_fraction: number; max_weight: number
}
export type IpoShadowDaily = {
  signal_date: string; outcome_known_date: string; sample_count: number; paired: boolean
  ipo: IpoModelMetrics; l4: IpoModelMetrics | null; proxy_return_delta: number | null; blockers: string[]
}
export type IpoShadowReadModel = {
  status: 'not_registered' | 'collecting' | 'observing' | 'unavailable'
  candidate_id: string | null; registered_at: string | null; latest_frozen_date: string | null
  frozen_dates: number; mature_dates: number; paired_dates: number; frozen_rows: number
  daily: IpoShadowDaily[]; blockers: string[]; promotion_allowed: false; exact_sparse_opb: false
}

function validMetrics(value: IpoModelMetrics | null): boolean {
  return value != null && (value.rank_ic === null || Number.isFinite(value.rank_ic))
    && ['rmse', 'proxy_net_return', 'invested_fraction', 'max_weight'].every(key => Number.isFinite(value[key]))
}

export async function readIpoShadow(db: D1Database, requestedDate: string): Promise<IpoShadowReadModel> {
  const base: IpoShadowReadModel = { status: 'not_registered', candidate_id: null, registered_at: null,
    latest_frozen_date: null, frozen_dates: 0, mature_dates: 0, paired_dates: 0, frozen_rows: 0,
    daily: [], blockers: [], promotion_allowed: false, exact_sparse_opb: false }
  try {
    const candidate = await db.prepare(`SELECT candidate_id, registered_at FROM ipo_shadow_candidates_v1
      WHERE date(registered_at, '+8 hours')<=?
      ORDER BY registered_at DESC, candidate_id DESC LIMIT 1`).bind(requestedDate).first<{ candidate_id: string; registered_at: string }>()
    if (!candidate) return { ...base, blockers: ['awaiting_first_native_snapshot_registration'] }
    const [coverage, evaluations] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS dates, COALESCE(SUM(row_count),0) AS rows, MAX(signal_date) AS latest
        FROM ipo_shadow_batches_v1 WHERE candidate_id=? AND signal_date<=?`)
        .bind(candidate.candidate_id, requestedDate).first<{ dates: number; rows: number; latest: string | null }>(),
      db.prepare(`SELECT metrics_json, COUNT(*) OVER() AS mature_dates,
        SUM(CASE WHEN json_extract(metrics_json,'$.paired')=1 THEN 1 ELSE 0 END) OVER() AS paired_dates FROM (
        SELECT signal_date, metrics_json,
          ROW_NUMBER() OVER (PARTITION BY signal_date ORDER BY evaluated_at DESC, rowid DESC) AS rn
        FROM ipo_shadow_daily_evaluations_v1 WHERE candidate_id=? AND business_date<=?
      ) WHERE rn=1 ORDER BY signal_date DESC LIMIT 120`)
        .bind(candidate.candidate_id, requestedDate).all<{ metrics_json: string; mature_dates: number; paired_dates: number }>(),
    ])
    const daily = (evaluations.results ?? []).map(row => JSON.parse(row.metrics_json) as IpoShadowDaily)
    if (daily.some(row => !row.signal_date || !validMetrics(row.ipo) || !Number.isInteger(row.sample_count)
      || row.sample_count <= 0 || (row.paired && (!validMetrics(row.l4) || !Number.isFinite(row.proxy_return_delta))))) {
      throw new Error('ipo_shadow_packet_invalid')
    }
    return { ...base, status: daily.length ? 'observing' : 'collecting',
      candidate_id: candidate.candidate_id, registered_at: candidate.registered_at,
      latest_frozen_date: coverage?.latest ?? null, frozen_dates: Number(coverage?.dates ?? 0),
      frozen_rows: Number(coverage?.rows ?? 0), mature_dates: Number(evaluations.results?.[0]?.mature_dates ?? 0),
      paired_dates: Number(evaluations.results?.[0]?.paired_dates ?? 0), daily,
      blockers: [...new Set(daily.flatMap(row => row.blockers ?? []))] }
  } catch (error) {
    // An observer failure remains visible without hiding the existing L4 panel.
    return { ...base, status: 'unavailable', blockers: ['ipo_shadow_read_failed',
      error instanceof Error && error.message.includes('no such table') ? 'ipo_shadow_migration_missing' : 'ipo_shadow_query_or_payload_error'] }
  }
}
