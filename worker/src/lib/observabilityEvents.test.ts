import {
  buildEventsFromAdaptiveMeta,
  buildEventsFromDataQuality,
  buildEventsFromGaOptimizer,
  buildEventsFromScheduler,
  buildEventsFromValidation,
  normalizeObservabilityAuditFilters,
  selectPersistableObservabilityEvents,
  type ObservabilityEvent,
} from './observabilityEvents'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const generatedAt = '2026-04-30T01:00:00.000Z'

{
  const events = buildEventsFromAdaptiveMeta({
    generatedAt,
    params: {
      confidence_delta: 0.07,
      bandit_max_mult: 1.5,
      provenance: {
        source: 'risk-assess',
        fallback: false,
        regime: 'volatile',
      },
      meta_layer: {
        alpha_vote_models: ['XGBoost', 'CatBoost', 'ExtraTrees', 'LightGBM', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer', 'TimesFM'],
        state_space_overlays: ['KalmanFilter', 'MarkovSwitching'],
        meta_optimizers: ['GAOptimizer'],
        formal_layer3_slots: ['TabM', 'GNN', 'iTransformer', 'TimesFM'],
      },
    },
  })

  assert(events.length === 1, 'adaptive meta should emit one contract event')
  assert(events[0].severity === 'ok', 'v2 adaptive meta payload should be ok')
  assert(events[0].domain === 'adaptive_meta', 'adaptive meta should have a dedicated OBS domain')
  assert(events[0].summary.includes('regime=volatile'), 'adaptive meta event should expose effective regime')
  assert((events[0].evidence.meta_layer as any).alpha_vote_count === 10, 'adaptive meta evidence should expose 10 alpha slots')
}

{
  const events = buildEventsFromGaOptimizer({
    generatedAt,
    state: {
      production_learning_loop: true,
      mutates_trading_config: false,
      updated_at: generatedAt,
      status: 'shadow_config',
      promotion: {
        level: 'L2',
        status: 'shadow_config',
        nextLevel: 'L3',
        approvalRequiredForNextLevel: true,
        canRequestNextLevel: false,
        missingEvidence: ['stale_snapshot'],
      },
      best: {
        score: 1.2,
        metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
        gate: { passed: true, failed_gates: [], checks: { pbo: true, monte_carlo_mdd_95th: true } },
        candidate: { params: { alphaFramework: { riskOverlay: { highVolThreshold: 0.05 } } } },
      },
      history: [{ generation: 0, best_score: 1.0 }, { generation: 1, best_score: 1.2 }],
    },
  })

  assert(events.length === 1, 'GA optimizer should emit one adaptive meta event')
  assert(events[0].domain === 'adaptive_meta', 'GA optimizer belongs to adaptive meta owner')
  assert(events[0].source === 'ga_optimizer', 'GA optimizer event source should be explicit')
  assert(events[0].summary.includes('next=L3'), 'GA optimizer event should expose promotion ladder next step')
  assert(events[0].summary.includes('ready_for_l3=yes'), 'GA optimizer event should expose L3 request readiness')
  assert((events[0].evidence.promotion as any).level === 'L2', 'GA optimizer evidence should include promotion level')
  assert((events[0].evidence.promotion as any).canRequestNextLevel === true, 'GA optimizer evidence should expose L3 approval request readiness')
  assert((events[0].evidence.promotion as any).missingEvidence.length === 0, 'GA optimizer should recompute stale missing evidence from current gates')
  assert((events[0].evidence.promotion as any).nextAction.includes('Ready to request Wei approval for L3'), 'GA optimizer should backfill concrete next action for older KV states')
  assert((events[0].evidence as any).mutates_trading_config === false, 'GA learning must not mutate trading config')
}

{
  const events = buildEventsFromAdaptiveMeta({
    generatedAt,
    params: {
      confidence_delta: 0.01,
      provenance: { source: 'unknown', fallback: true },
    },
  })

  assert(events[0].severity === 'warn', 'legacy/fallback adaptive params should be visible as warning')
  assert(events[0].status === 'fallback', 'fallback adaptive params should not look healthy')
}

{
  const events = buildEventsFromScheduler({
    generatedAt,
    jobs: [
      {
        id: 'pipeline',
        name: 'Pipeline',
        group: 'pipeline_chain',
        lastStatus: 'failed',
        lastDuration: '12s',
        lastRun: '4/30 22:00',
        summary: 'callback timeout',
      },
    ],
  })

  assert(events.length === 1, 'failed scheduler job should create one event')
  assert(events[0].severity === 'error', 'failed scheduler job should be error severity')
  assert(events[0].domain === 'scheduler', 'scheduler event should keep scheduler domain')
  assert(events[0].next_action.includes('callback'), 'scheduler event should point to callback investigation')
}

{
  const events = buildEventsFromDataQuality({
    generatedAt,
    checks: [
      {
        id: 'price_freshness',
        label: 'Price data',
        status: 'fail',
        summary: 'latest=2026-04-29 lag=1d',
        metrics: { latest_date: '2026-04-29', target_date: '2026-04-30' },
      },
      { id: 'schema', label: 'Schema', status: 'ok', summary: 'ok' },
    ],
  })

  assert(events.length === 1, 'data quality should emit actionable non-ok checks only')
  assert(events[0].severity === 'error', 'failed data quality check should be error severity')
  assert(events[0].title === 'Price data', 'data quality event should preserve check label')
  assert(events[0].ts === '2026-04-29T00:00:00.000Z', 'data quality event should use evidence time instead of page refresh time')
}

{
  const events = buildEventsFromValidation({
    generatedAt,
    validationPackets: [{
      source: 'backtest_replay',
      decision: 'FAIL',
      failed_gates: ['pbo', 'deflated_sharpe'],
      warnings: ['walk_forward'],
      gates: [
        { name: 'pbo', status: 'FAIL', reason: 'overfit probability too high' },
        { name: 'deflated_sharpe', status: 'FAIL', reason: 'multiple testing adjusted edge too weak' },
      ],
    }],
  })

  assert(events.length === 1, 'failed validation packet should create one event')
  assert(events[0].domain === 'validation', 'validation event should use validation domain')
  assert(events[0].severity === 'error', 'failed validation packet should be error severity')
  assert(events[0].summary.includes('pbo'), 'validation event should expose failed gates')
  assert(events[0].next_action.includes('Strategy Lab'), 'validation event should point to strategy evidence review')
}

{
  const warnEvent: ObservabilityEvent = {
    id: 'data_quality:price',
    ts: generatedAt,
    severity: 'warn',
    domain: 'data_quality',
    source: 'data_quality_report',
    status: 'warn',
    title: 'Price data',
    summary: 'stale',
    owner: 'Worker',
    impact: 'degraded',
    next_action: 'trace writer',
    evidence: {},
  }
  const okEvent: ObservabilityEvent = {
    ...warnEvent,
    id: 'scheduler:stable',
    severity: 'ok',
    domain: 'scheduler',
    source: 'scheduler_status',
    status: 'ok',
    title: 'Scheduler stable',
    summary: 'ok',
  }

  const mixed = selectPersistableObservabilityEvents([okEvent, warnEvent])
  assert(mixed.length === 1 && mixed[0].id === warnEvent.id, 'audit snapshot should persist non-ok events before stable noise')

  const stable = selectPersistableObservabilityEvents([okEvent, { ...okEvent, id: 'data_quality:stable' }])
  assert(stable.length === 1 && stable[0].id === okEvent.id, 'fully healthy snapshot should persist one stable baseline only')
}

{
  const filters = normalizeObservabilityAuditFilters({
    date: '2026-04-30',
    severity: 'critical',
    domain: 'legacy_cron',
    limit: '999',
  })

  assert(filters.date === '2026-04-30', 'audit filter should preserve valid date')
  assert(filters.severity === undefined, 'audit filter should drop unknown severity')
  assert(filters.domain === undefined, 'audit filter should drop unknown domain')
  assert(filters.limit === 200, 'audit filter should clamp oversized limit')
}
