export type PipelineMaturityStatus =
  | 'serving'
  | 'ready'
  | 'collecting'
  | 'failed_quality'
  | 'blocked'
  | 'unavailable'

export type PipelineContributionMode = 'production' | 'shadow' | 'evidence_only'

export type PipelineMaturityMetric = {
  key: string
  label: string
  value: number | string | boolean | null
  target?: number | string | boolean | null
  comparator?: 'gte' | 'gt' | 'lt' | 'eq'
  unit?: 'rows' | 'dates' | 'ratio' | 'return' | 'r_multiple' | 'score' | 'count' | 'status'
  passed?: boolean | null
  note?: string
}

export type PipelineMaturityStage = {
  id: 'threshold_margin_affinity_v2' | 'oof_redundancy' | 'route_score_v2' | 'l4' | 'fusion'
  layer: string
  title: string
  version: string | null
  status: PipelineMaturityStatus
  contribution_mode: PipelineContributionMode
  maturity_kind: 'daily_coverage' | 'paired_oof' | 'calibration' | 'artifact_quality'
  progress: {
    current: number
    required: number
    remaining: number
    ratio: number
    unit: 'rows' | 'dates'
    complete: boolean
  } | null
  decision: string
  contribution: string
  production_effect: string
  blockers: string[]
  metrics: PipelineMaturityMetric[]
  history?: Array<{
    evidence_date: string
    value: number | null
    target: number | null
    unit: PipelineMaturityMetric['unit']
  }>
  lineage: {
    requested_date: string
    evidence_date: string | null
    oof_max_date?: string | null
    artifact_id?: string | null
    model_version?: string | null
    oof_applicable?: boolean
    evidence_semantics?: string
    source: string
    updated_at?: string | null
  }
}

export type StrategyRouteBundleMaturity = {
  version: string
  status: PipelineMaturityStatus
  contribution_mode: PipelineContributionMode
  threshold_coverage_ready: boolean
  current_route_coverage_complete: boolean
  current_route_rows: number
  current_reference_rows: number
  route_calibration_status: string | null
  route_mature_dates: number
  route_required_dates: number
  promoted_run_id: string | null
  blockers: string[]
}

export type PipelineDecisionMaturityPacket = {
  schema_version: 'pipeline-decision-maturity-v1'
  requested_date: string
  generated_at: string
  current_expected_return_owner: 'l4_alpha_ev' | 'allocator_ev_fusion' | null
  action_gate: 'expected_return_owner' | 'fusion_primary_required'
  strategy_route_bundle?: StrategyRouteBundleMaturity
  summary: {
    production: number
    shadow: number
    ready: number
    collecting: number
    failed_or_blocked: number
  }
  stages: PipelineMaturityStage[]
}
