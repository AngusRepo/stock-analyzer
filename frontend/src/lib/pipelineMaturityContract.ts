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
  availability?: 'available' | 'pending' | 'not_applicable' | 'missing' | 'blocked'
  reason_code?: string | null
  scope?: 'promotion_gate' | 'lifecycle' | 'monitoring' | 'diagnostic' | 'production'
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
  blocker_groups?: Array<{
    scope: 'offline_candidate' | 'serving_pointer' | 'frozen_forward' | 'runtime_guard'
    title: string
    blockers: string[]
  }>
  metrics: PipelineMaturityMetric[]
  history?: Array<{
    evidence_date: string
    value: number | null
    target: number | null
    unit: PipelineMaturityMetric['unit']
    artifact_contract_version?: string | null
    identity_valid?: boolean
  }>
  lineage: {
    requested_date: string
    evidence_date: string | null
    data_cutoff_date?: string | null
    mature_outcome_max_date?: string | null
    oof_max_date?: string | null
    frozen_forward_business_date?: string | null
    artifact_id?: string | null
    model_version?: string | null
    oof_applicable?: boolean
    evidence_semantics?: string
    source: string
    updated_at?: string | null
    cadence?: 'daily' | 'weekly' | 'monthly' | 'manual' | 'event-driven' | 'unknown'
    role?: 'candidate' | 'serving' | 'monitoring' | 'runtime_guard'
    date_semantic?: 'candidate_cutoff' | 'current_pointer_effective_at' | 'monitoring_business_date' | 'latest_prediction_date'
    oof_unavailable_reason?: string | null
    evidence_scopes?: {
      offline_candidate?: {
        cadence: 'daily' | 'weekly' | 'monthly' | 'manual' | 'event-driven' | 'unknown'
        role: 'candidate'
        date_semantic: 'candidate_cutoff'
        availability: 'available' | 'blocked' | 'missing'
        reason_code: string | null
        identity_assurance: string | null
        artifact_id: string | null
        model_version: string | null
        artifact_contract_version: string | null
        validation_schema_version: string | null
        source_run_date: string | null
        oof_max_date: string | null
        updated_at: string | null
      }
      serving_pointer?: {
        cadence: 'event-driven'
        role: 'serving'
        date_semantic: 'current_pointer_effective_at'
        availability: 'available' | 'blocked' | 'missing'
        artifact_state: string | null
        observed_at: string | null
        reason_code: string | null
        artifact_id: string | null
        model_version: string | null
        artifact_contract_version: string | null
        serving_mode: string | null
        updated_at: string | null
      }
      frozen_forward?: {
        cadence: 'daily'
        role: 'monitoring'
        date_semantic: 'monitoring_business_date'
        availability: 'available' | 'blocked' | 'missing'
        reason_code: string | null
        evaluation_id: string | null
        cohort_id: string | null
        model_version: string | null
        validation_schema_version: string | null
        business_date: string | null
        oof_max_date: string | null
        updated_at: string | null
      }
      runtime_guard?: {
        cadence: 'daily'
        role: 'runtime_guard'
        date_semantic: 'latest_prediction_date'
        availability: 'available' | 'blocked'
        reason_code: string | null
        artifact_id: string
        model_fingerprint: string
        model_version: string
        state: string
        evaluable_date_count: number
        degraded_streak: number
        recovery_streak: number
        last_prediction_date: string
        lineage_bound: boolean
      }
    }
  }
}

export type StrategyRouteMaturityProjection = {
  schemaVersion: 'strategy-route-maturity-projection-v1'
  asOfDate: string
  labelHorizonSessions: 5
  requiredDates: number
  eligibleDates: number
  pendingDates: number
  unavailableDates: number
  datesRemaining: number
  earliestPendingMaturityDate: string | null
  bestCaseThresholdDate: string | null
  status: 'complete' | 'projected' | 'calendar_unavailable'
  assumption: 'future_signal_dates_are_projection_only_and_require_full_v5_carrier_closure'
  dates: Array<{
    signalDate: string
    status: 'eligible' | 'unavailable' | 'pending_maturity'
    expectedMaturityDate: string | null
    blockers: string[]
  }>
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
  maturity_projection?: StrategyRouteMaturityProjection
}

export type PipelineDecisionMaturityPacket = {
  schema_version: 'pipeline-decision-maturity-v2'
  requested_date: string
  generated_at: string
  current_selection_signal_owner: 'score_v2_formal_ml'
  current_expected_return_owner: 'l4_alpha_ev' | 'allocator_ev_fusion' | null
  current_allocation_utility_owner: 'expected_return_owner' | 'formal_ml_buy_admission'
  current_execution_owner: 'allocator_opb_policy'
  execution_scope: 'recommendation_allocation_only_no_order_submission'
  action_gate: 'expected_return_owner' | 'selection_signal_owner'
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
