export type PipelineMaturityStatus =
  | 'serving'
  | 'ready'
  | 'collecting'
  | 'failed_quality'
  | 'blocked'
  | 'abstaining'
  | 'unavailable'

export type PipelineContributionMode = 'production' | 'shadow' | 'evidence_only' | 'abstention'

export type PipelineMaturityMetric = {
  key: string
  label: string
  value: number | string | boolean | null
  target?: number | string | boolean | null
  comparator?: 'gte' | 'gt' | 'lt' | 'eq'
  unit?: 'rows' | 'dates' | 'ratio' | 'return' | 'score' | 'count' | 'status'
  passed?: boolean | null
  note?: string
}

export type PipelineMaturityStage = {
  id: 'threshold_margin_affinity_v2' | 'oof_redundancy' | 'route_score_v2' | 's12' | 'l4' | 'fusion'
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
  lineage: {
    requested_date: string
    evidence_date: string | null
    oof_max_date?: string | null
    artifact_id?: string | null
    model_version?: string | null
    source: string
    updated_at?: string | null
  }
}

export type PipelineDecisionMaturityPacket = {
  schema_version: 'pipeline-decision-maturity-v1'
  requested_date: string
  generated_at: string
  current_expected_return_owner: 'l4_alpha_ev' | 'allocator_ev_fusion' | null
  action_gate: 'expected_return_owner' | 'validated_s12_only'
  summary: {
    production: number
    shadow: number
    ready: number
    collecting: number
    failed_or_blocked: number
  }
  stages: PipelineMaturityStage[]
}
