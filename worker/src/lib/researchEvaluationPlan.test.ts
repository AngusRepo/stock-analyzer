import { buildResearchEvaluationPlan } from './researchEvaluationPlan'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const plan = buildResearchEvaluationPlan({
    id: 'exp-breakout',
    version: 'research-registry-v1',
    status: 'draft',
    hypothesis: '測試突破型策略是否在多頭 regime 改善風險調整後報酬',
    source_refs: ['strategy-lab-ui'],
    strategy_spec_ids: ['breakout_vol_expansion_seed_v1'],
    data_slice: { start_date: '2025-01-01', end_date: '2026-04-30', universe: 'twse_tpex_auto_tradable' },
    metrics: ['walk_forward_sharpe', 'pbo', 'mdd_95th'],
    follow_up: ['run dry-run backtest', 'prepare review packet'],
    approval_gate: {
      can_research: true,
      can_generate_patch_or_report: true,
      can_retrain_prod: false,
      can_promote: false,
      can_deploy: false,
      can_trade: false,
    },
    created_at: '2026-04-30T01:00:00.000Z',
    updated_at: '2026-04-30T01:00:00.000Z',
  })

  assert(plan.experiment_id === 'exp-breakout', 'plan should preserve experiment id')
  assert(plan.mode === 'dry_run_only', 'plan should be dry-run only')
  assert(plan.steps.length >= 3, 'plan should include backtest, walk-forward and verify planning steps')
  assert(plan.steps.every((step) => step.mutation_allowed === false), 'research evaluation steps must not mutate production')
  const backtest = plan.steps.find((step) => step.kind === 'backtest')
  const walkForward = plan.steps.find((step) => step.kind === 'walk_forward')
  const verify = plan.steps.find((step) => step.kind === 'verify')
  assert(backtest?.controller_endpoint === '/backtest/replay', 'backtest research plan should use non-persisting replay endpoint')
  assert(backtest?.body.persist_results === false, 'backtest replay must disable persistence')
  assert(backtest?.body.persist_confirm === false, 'backtest replay must not confirm persistence')
  assert(walkForward?.controller_endpoint === '/walk_forward/dry-run', 'walk-forward research plan should use dry-run endpoint')
  assert(verify?.controller_endpoint === '/verify/dry-run', 'verify research plan should use real dry-run endpoint')
  assert(verify?.execution_ready === true, 'verify should be executable once dry-run endpoint exists')
  assert(!plan.steps.some((step) => step.controller_endpoint === '/backtest/run'), 'research plan must not use mutating /backtest/run')
  assert(!plan.steps.some((step) => step.controller_endpoint === '/walk_forward/run'), 'research plan must not use mutating /walk_forward/run')
  assert(!plan.steps.some((step) => step.controller_endpoint === '/verify/run'), 'research plan must not use mutating /verify/run')
  assert(plan.blocked_capabilities.includes('production deploy'), 'plan should expose blocked deploy capability')
}

{
  const plan = buildResearchEvaluationPlan({
    id: 'exp-model-upgrade',
    version: 'research-registry-v1',
    status: 'draft',
    hypothesis: '評估 TabM iTransformer TimesFM 是否值得進 challenger pool',
    source_refs: ['model-upgrade-track'],
    strategy_spec_ids: ['model_family_benchmark_v1'],
    data_slice: {
      start_date: '2025-01-01',
      end_date: '2026-04-30',
      benchmark_candidates: ['TabM', 'iTransformer', 'TimesFM'],
    },
    metrics: ['model_benchmark', 'oos_ic', 'pbo', 'cost_sensitivity'],
    follow_up: ['produce benchmark review packet'],
    approval_gate: {
      can_research: true,
      can_generate_patch_or_report: true,
      can_retrain_prod: false,
      can_promote: false,
      can_deploy: false,
      can_trade: false,
    },
    created_at: '2026-04-30T01:00:00.000Z',
    updated_at: '2026-04-30T01:00:00.000Z',
  })

  const benchmarkSteps = plan.steps.filter((step) => step.kind === 'model_benchmark')
  assert(benchmarkSteps.length === 3, 'model upgrade research should create one benchmark step per supported requested candidate')
  assert(
    benchmarkSteps.every((step) => step.controller_endpoint === '/research/model-benchmark/dry-run'),
    'model benchmark steps should call the research benchmark endpoint',
  )
  assert(
    benchmarkSteps.every((step) => step.mutation_allowed === false && step.body.persist_results === false),
    'model benchmark steps must stay non-mutating',
  )
  assert(
    benchmarkSteps.map((step) => step.body.candidate_id).join(',') === 'TabM,iTransformer,TimesFM',
    'model benchmark steps should preserve supported benchmark candidates',
  )
}

{
  const plan = buildResearchEvaluationPlan({
    id: 'exp-short',
    version: 'research-registry-v1',
    status: 'draft',
    hypothesis: 'too short',
    source_refs: [],
    strategy_spec_ids: [],
    data_slice: {},
    metrics: [],
    follow_up: [],
    approval_gate: {
      can_research: true,
      can_generate_patch_or_report: true,
      can_retrain_prod: false,
      can_promote: false,
      can_deploy: false,
      can_trade: false,
    },
    created_at: '2026-04-30T01:00:00.000Z',
    updated_at: '2026-04-30T01:00:00.000Z',
  })

  assert(plan.warnings.includes('strategy_spec_ids_missing'), 'plan should warn when strategy specs are missing')
  assert(plan.warnings.includes('metrics_missing'), 'plan should warn when metrics are missing')
}
