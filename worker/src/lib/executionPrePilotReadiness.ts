export interface ExecutionPrePilotPhase {
  id: string
  status: 'implemented' | 'active' | 'deferred'
  liveSubmitEnabled: boolean
  owner: 'stockvision' | 'finlab_sinopac' | 'shared'
  evidence: string[]
}

export interface ExecutionPrePilotReadiness {
  schemaVersion: 'execution-pre-pilot-readiness-v1'
  targetState: 'before_small_real_order_pilot'
  liveSubmitEnabled: boolean
  requiredFeatureFlags: string[]
  phases: ExecutionPrePilotPhase[]
}

export function buildExecutionPrePilotReadiness(): ExecutionPrePilotReadiness {
  return {
    schemaVersion: 'execution-pre-pilot-readiness-v1',
    targetState: 'before_small_real_order_pilot',
    liveSubmitEnabled: false,
    requiredFeatureFlags: [
      'FINLAB_L5_MARKET_DATA_ENABLED',
      'FINLAB_EXECUTION_LOOP_ENABLED',
      'INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED',
      'FINLAB_L5_ENVELOPE_GUARD_ENABLED',
    ],
    phases: [
      {
        id: 'phase0_ownership',
        status: 'implemented',
        liveSubmitEnabled: false,
        owner: 'shared',
        evidence: ['stockvision_final_decision_owner', 'finlab_broker_adapter_owner'],
      },
      {
        id: 'phase1_l5_market_data_lane',
        status: 'active',
        liveSubmitEnabled: false,
        owner: 'finlab_sinopac',
        evidence: ['finlab_l5_market_data_event', 'can_submit_real_order_false', 'l5_envelope_guard'],
      },
      {
        id: 'phase2_10s_execution_loop',
        status: 'active',
        liveSubmitEnabled: false,
        owner: 'finlab_sinopac',
        evidence: ['poll_seconds_min_10', 'worker_intraday_check_paper_order'],
      },
      {
        id: 'phase3_dynamic_intraday_decision',
        status: 'active',
        liveSubmitEnabled: false,
        owner: 'stockvision',
        evidence: ['rolling_bar_floor_30s', 'hybrid_atr_obv_adaptive_rsi', 'technical_decision_gate', 'vwap_reclaim_state'],
      },
      {
        id: 'phase4_adaptive_execution_gate',
        status: 'active',
        liveSubmitEnabled: false,
        owner: 'stockvision',
        evidence: ['strategy_aware_thresholds', 'l5_quality_chase_control'],
      },
      {
        id: 'phase5_finlab_preview_order_preparation',
        status: 'deferred',
        liveSubmitEnabled: false,
        owner: 'finlab_sinopac',
        evidence: ['preview_disabled_until_broker_preview_factory_exists', 'live_submit_enabled_false'],
      },
      {
        id: 'phase6_paper_broker_reconciliation',
        status: 'active',
        liveSubmitEnabled: false,
        owner: 'shared',
        evidence: ['paper_broker_reconciliation_event', 'intent_preview_fill_diff'],
      },
    ],
  }
}

export function validateExecutionPrePilotReadiness(readiness: ExecutionPrePilotReadiness): string[] {
  const errors: string[] = []
  if (readiness.liveSubmitEnabled) errors.push('pre_pilot_must_not_enable_live_submit')
  if (readiness.targetState !== 'before_small_real_order_pilot') errors.push('target_state_must_stop_before_real_order_pilot')
  for (const phase of readiness.phases) {
    if (phase.liveSubmitEnabled) errors.push(`${phase.id}_must_not_enable_live_submit`)
  }
  const phaseIds = new Set(readiness.phases.map((phase) => phase.id))
  for (const required of [
    'phase0_ownership',
    'phase1_l5_market_data_lane',
    'phase2_10s_execution_loop',
    'phase3_dynamic_intraday_decision',
    'phase4_adaptive_execution_gate',
    'phase5_finlab_preview_order_preparation',
    'phase6_paper_broker_reconciliation',
  ]) {
    if (!phaseIds.has(required)) errors.push(`missing_${required}`)
  }
  return errors
}
