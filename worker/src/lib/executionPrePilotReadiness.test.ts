import {
  buildExecutionPrePilotReadiness,
  validateExecutionPrePilotReadiness,
} from './executionPrePilotReadiness'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const readiness = buildExecutionPrePilotReadiness()
  assert(readiness.targetState === 'before_small_real_order_pilot', 'readiness target should stop before real-order pilot')
  assert(readiness.liveSubmitEnabled === false, 'pre-pilot readiness must never enable live submit')
  assert(readiness.phases.length === 7, 'Phase 0 through Phase 6 should be represented')
  assert(readiness.phases[0].id === 'phase0_ownership', 'Phase 0 should freeze ownership')
  assert(readiness.phases[6].id === 'phase6_paper_broker_reconciliation', 'Phase 6 should close paper-broker reconciliation')
  assert(readiness.requiredFeatureFlags.includes('FINLAB_L5_MARKET_DATA_ENABLED'), 'L5 market-data flag should be explicit')
  assert(readiness.requiredFeatureFlags.includes('INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED'), 'dynamic technical guard flag should be explicit')
  assert(validateExecutionPrePilotReadiness(readiness).length === 0, 'default readiness should validate')
}

{
  const errors = validateExecutionPrePilotReadiness({
    ...buildExecutionPrePilotReadiness(),
    liveSubmitEnabled: true,
  })
  assert(errors.includes('pre_pilot_must_not_enable_live_submit'), 'readiness validation must reject live submit before pilot')
}
