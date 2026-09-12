export type StrategyNavEvidence = {
  schema_version: 'strategy-nav-evidence-v1'
  strategy_id: string; strategy_version: string; as_of_date: string; observed_at: string
  current_replacement_owner: 'original_paired_daily_nav' | 'legacy_atomic_v7'
  status: 'available' | 'unavailable' | 'not_registered'; entry_count: number
  read_only: true; promotion_allowed: false
  entries: Array<{
    artifact_id: string; artifact_checksum: string; source_run_date: string
    strategy_roles: Array<'candidate' | 'incumbent'>
    status: 'available' | 'unavailable'; error: string | null
    policy_definition: {
      candidate: { id: string; version: string; name?: string }
      incumbent: { id: string; version: string; name?: string }
    }
    nav: null | {
      decision: 'PASS' | 'HOLD' | 'PENDING' | 'FAIL'; reason: string; as_of_date: string
      minimum_evaluable_dates: number; maximum_evaluable_dates: number
      evaluable_date_count?: number | null; mean_daily_nav_delta?: number | null
      holm_adjusted_p?: number | null; review_alpha?: number | null
      checkpoint_as_of_date?: string | null; review_id?: string | null
      decision_checksum: string; family_id?: string | null; baseline_checksum?: string | null
      latest_signal_date?: string | null; maximum_window_exhausted?: boolean
    }
    publication: null | { receipt_checksum: string; knowledge_cutoff_date: string
      decision_checksum: string; historical_publication_verified: true }
  }>
}
