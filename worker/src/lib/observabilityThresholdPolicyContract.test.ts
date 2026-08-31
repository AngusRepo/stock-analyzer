import {
  buildEventsFromMlThresholdPolicy,
  selectRuntimeSignalPolicyFromForecastRows,
} from './observabilityEvents'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const [event] = buildEventsFromMlThresholdPolicy({
  generatedAt: '2026-08-28T12:00:00.000Z',
  requestedDate: '2026-08-28',
  evidenceDate: '2026-08-24',
  latestPredictionDate: '2026-08-24',
  sampleCount: 416,
  policy: {
    policy_id: 'bootstrap-trading-config-ensemble-v2',
    status: 'resolved',
    source: 'bootstrap',
    selected_regime: 'sideways',
    thresholds: { buyThreshold: 0.6, sellThreshold: 0.4 },
    adaptive_overlay: { applied_delta: 0 },
    validation_evidence: { status: 'bootstrap_compat' },
  },
})

assert(event.status === 'stale_bootstrap', 'latest-as-of policy must remain visibly stale')
assert(event.severity === 'warn', 'stale policy must not render as healthy')
assert(event.evidence.stale_days === 4, 'policy evidence must expose exact calendar staleness')
assert(event.evidence.requested_date === '2026-08-28', 'event must preserve requested observation date')
assert(event.evidence.evidence_date === '2026-08-24', 'event must preserve actual evidence date')

const [active8Event] = buildEventsFromMlThresholdPolicy({
  generatedAt: '2026-08-28T12:00:00.000Z',
  requestedDate: '2026-08-28',
  evidenceDate: '2026-08-28',
  latestPredictionDate: '2026-08-28',
  sampleCount: 632,
  policy: {
    policy_id: 'active8-ensemble:test',
    status: 'active',
    source: 'active8_ensemble_artifact',
    selected_regime: 'regime_independent',
    thresholds: { buyCoverage: 0.9, strongCoverage: 0.95 },
    adaptive_overlay: { status: 'not_applicable', applied_delta: null },
    validation_evidence: { decision: 'PASS' },
  },
})

assert(active8Event.status === 'active', 'canonical Active-8 signal policy must be the runtime owner')
assert(active8Event.severity === 'ok', 'same-date Active-8 signal policy evidence must be healthy')

const selectedPolicy = selectRuntimeSignalPolicyFromForecastRows([
  {
    forecast_data: JSON.stringify({
      ensemble_v2: {
        ml_threshold_policy: {
          policy_id: 'legacy-newer-row',
          status: 'resolved',
          source: 'bootstrap',
        },
      },
    }),
  },
  {
    forecast_data: JSON.stringify({
      ensemble_v2: {
        artifact_id: 'active8-canonical-row',
        artifact_checksum: 'canonical-checksum',
        signal_policy: { buy_coverage: 0.9, strong_coverage: 0.95 },
        validation: { decision: 'PASS' },
      },
    }),
  },
])

assert(selectedPolicy?.source === 'active8_ensemble_artifact', 'canonical policy must win across the complete date batch')
assert(selectedPolicy?.policy_id === 'active8-canonical-row', 'row order must not allow legacy policy to shadow Active-8')
