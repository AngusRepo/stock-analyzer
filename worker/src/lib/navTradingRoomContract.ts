/** Shared read-only contract, kept inside the Cloud Run Worker source root. Not a gate. */
export interface NavAccountView {
  cash: number | null
  nav: number | null
  daily_return: number | null
  drawdown: number | null
  costs: number | null
  fill_count: number | null
  positions: Array<{ symbol: string; shares: number; mark: number | null; market_value: number | null }>
  stock_utilization: number | null
  rights_count: number
}
export interface NavFillView {
  fill_id: string; symbol: string; side: string; shares: number; price: number
  commission: number | null; tax: number | null; executed_at: string | null
}
export interface NavComparisonDetail {
  status: 'available' | 'not_found' | 'unavailable'
  pair_id: string
  as_of: string
  history_truncated: boolean
  history: Array<{ date: string; candidate_nav: number | null; baseline_nav: number | null;
    candidate_return: number | null; baseline_return: number | null; net_return_delta: number | null }>
  latest: null | { date: string; candidate: NavAccountView; baseline: NavAccountView;
    receipt_status: 'verified' | 'missing' | 'invalid';
    fills: { candidate: NavFillView[]; baseline: NavFillView[] } | null }
  blockers: string[]
}
