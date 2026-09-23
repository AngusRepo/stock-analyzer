export interface StrategyPick { symbol: string; weight: number }
export interface StrategyAllocationView {
  status: 'available' | 'unavailable'; picks: StrategyPick[]; cash_weight: number | null
  source_id: string | null; reason?: string
}
export interface StrategyAbRecommendations {
  schema_version: 'strategy-ab-recommendations-v1'; date: string
  scope: 'daily_allocation' | 'retrospective_research'; generated_at: string
  production_effect: false; nav_maturity_credit: 0
  A: StrategyAllocationView; B: StrategyAllocationView
  source_checksums?: Record<string, string>
}
