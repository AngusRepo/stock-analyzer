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
  collection?: { signal_date: string; observed_at: string; status: string; candidate_rows?: number; eligible_rows?: number; blockers: string[] } | null
}
