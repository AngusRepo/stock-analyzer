import type { Bindings } from '../types'

export type DataDomain = 'core' | 'market' | 'learning' | 'ops' | 'execution' | 'paper' | 'research'

export const DATA_DOMAINS: readonly DataDomain[] = [
  'core', 'market', 'learning', 'ops', 'execution', 'paper', 'research',
]

export const MULTI_D1_ROUTING_CONTRACT_GATES = {
  active_domain_ready_guard: true,
  invalid_domain_config_fail_closed: true,
  shadow_owned_registry_complete: true,
  direct_legacy_db_paths_closed: false,
  cross_domain_read_models_closed: false,
  active_read_write_readback_probes_automated: false,
  rollback_restore_probes_automated: false,
} as const

export const MULTI_D1_PROJECTION_CONTRACT_GATES = {
  typed_outbox_producers_wired: false,
  idempotent_inbox_consumers_wired: false,
  replay_and_dead_letter_recovery_automated: false,
  freshness_sla_and_zero_error_gate_automated: false,
} as const

export const MULTI_D1_STRICT_ROUTING_READY = Object.values(
  MULTI_D1_ROUTING_CONTRACT_GATES,
).every(Boolean)
export const MULTI_D1_PROJECTION_CONTRACT_READY = Object.values(
  MULTI_D1_PROJECTION_CONTRACT_GATES,
).every(Boolean)

const DOMAIN_TABLES: Record<DataDomain, ReadonlySet<string>> = {
  core: new Set([
    'users', 'stocks', 'watchlist', 'risk_metrics', 'alert_rules', 'market_risk',
    'chat_sessions', 'chat_messages', 'alert_notifications', 'daily_recommendations',
  ]),
  market: new Set([
    'stock_prices', 'technical_indicators', 'financials', 'canonical_fundamental_features',
    'chip_data', 'news', 'factor_scores', 'sector_flow', 'market_breadth',
    'market_trading_sessions', 'intraday_minute_bars',
    'sector_taxonomy_membership_snapshots_v1', 'sector_taxonomy_snapshot_runs_v1',
  ]),
  learning: new Set([
    'predictions', 's12_replay_trade_outcomes', 's12_structure_snapshots',
    's12_tw_calibration_runs', 's12_tw_calibration_artifacts', 'state_space_shadow_results',
    'model_accuracy', 'stock_memories', 'trade_performance', 'dataset_snapshots',
    'model_artifact_registry', 'model_champion_history', 'model_champion_pointers',
    'expected_return_artifact_payloads', 'allocator_ev_feature_snapshots',
    'allocator_ev_snapshot_runs',
    'allocator_ev_feature_snapshot_staging', 'active8_oof_cohorts',
    'active8_oof_fold_artifacts', 'active8_oof_materialized_artifacts',
    'active8_oof_predictions', 'allocator_ev_oof_snapshots', 'l4_oof_predictions',
    'active8_oof_date_eligibility', 'active8_oof_materialized_artifact_history',
    'active8_oof_retention_ledger', 's12_formal_ev_decisions',
    'strategy_spec_registry', 'strategy_decision_log', 'selection_reference_snapshots_v1',
    'strategy_label_matrix_v4', 'strategy_label_matrix_runs_v4', 'selection_reference_repair_runs_v1',
    'active8_oof_forward_extension_coverage',
    'selection_reference_identity_repair_runs_v1',
    'strategy_route_calibration_runs_v1', 'strategy_route_calibration_head_v1',
    'strategy_route_backfill_eligibility_v1',
    'strategy_redundancy_artifacts_v1',
    'strategy_reward_ledger', 'strategy_learning_daily_stats', 'strategy_learning_head',
    'strategy_policy_state', 'strategy_evidence_rebuild_runs_v5',
    'strategy_replacement_decisions_v5', 'strategy_replacement_cutover_guards_v5',
    'parameter_candidate_registry', 'parameter_candidate_evidence',
    'parameter_candidate_events', 'entry_model_replay_reports',
    'canonical_selection_labels_v4', 'canonical_selection_label_rejections_v4',
    'canonical_selection_label_runs_v4', 'strategy_marginal_edge_runs_v4',
    'strategy_marginal_edge_v4', 'strategy_marginal_edge_dates_v4',
    'strategy_marginal_edge_head_v4',
    'price_horizon_labels_v1', 'price_horizon_label_rejections_v1',
    'allocator_ev_daily_lifecycle',
    'strategy_production_policy_history_v1', 'expected_return_shadow_evaluation_packets',
    'adaptive_meta_policy_decisions', 'active8_oof_freshness_sla',
    'strategy_adaptive_policy_history_v2',


  ]),
  ops: new Set([
    'system_logs', 'observability_events', 'screener_funnel_runs', 'screener_funnel_items',
    'pipeline_stage_runs', 'strategy_learning_runs', 'maintenance_task_leases',
    'legacy_migration_cursors', 'scheduler_locks', 'artifact_hard_references',
    'domain_projection_outbox', 'domain_projection_inbox', 'data_domain_cutovers',
    'data_retention_policies', 'data_retention_runs', 'storage_capacity_daily',
    'price_horizon_projection_status', 'price_horizon_projection_runs',
    'sector_flow_pit_rebuild_runs_v1',
    'data_domain_backfill_cursors', 'data_domain_parity_checks',
    'data_retention_cursors', 'data_retention_run_items',
    's12_structure_batch_runs', 's12_structure_batch_shards',
  ]),
  execution: new Set([
    'broker_execution_intents', 'broker_execution_legs', 'broker_execution_events',
  ]),
  paper: new Set([
    'paper_accounts', 'paper_orders', 'paper_positions', 'paper_settlements',
    'paper_daily_snapshots', 'paper_execution_events', 'paper_order_intents',
    'paper_exit_intents', 'paper_challenger_candidates',
    'paper_challenger_daily_metrics', 'paper_decision_attribution',
  ]),
  research: new Set([
    'input_snapshots', 'feature_versions', 'features', 'strategy_versions', 'strategies',
    'analysis_runs', 'workflow_steps', 'workflow_checkpoints', 'model_calls',
    'feature_clusters', 'gap_maps', 'hypotheses', 'candidates', 'candidate_lineage',
    'static_validation_results', 'audit_issues', 'cross_examinations', 'artifacts',
    'codex_imports', 'strategy_verdicts', 'candidate_verdicts', 'issue_verdicts',
  ]),
}

const SHADOW_BACKFILL_EXCLUDED_TABLES: Partial<Record<DataDomain, ReadonlySet<string>>> = {
  learning: new Set(['entry_model_replay_reports']),
  ops: new Set([
    'maintenance_task_leases',
    'data_domain_cutovers',
    'data_domain_backfill_cursors',
    'data_domain_parity_checks',
  ]),
}

// Shadow copies must respect the same foreign-key topology as the legacy DB.
// Keep this map next to the ownership registry so every durable backfill path
// receives parent rows before child rows, independent of alphabetical names.
const SHADOW_BACKFILL_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  active8_oof_fold_artifacts: ['active8_oof_cohorts'],
  active8_oof_materialized_artifacts: ['active8_oof_cohorts'],
  active8_oof_predictions: ['active8_oof_cohorts'],
  allocator_ev_feature_snapshot_staging: ['allocator_ev_snapshot_runs'],
  allocator_ev_oof_snapshots: ['active8_oof_cohorts'],
  data_retention_cursors: ['data_retention_policies'],
  data_retention_run_items: ['data_retention_runs'],
  data_retention_runs: ['data_retention_policies'],
  expected_return_artifact_payloads: ['model_artifact_registry'],
  l4_oof_predictions: ['active8_oof_cohorts'],
  s12_structure_batch_shards: ['s12_structure_batch_runs'],
  strategy_marginal_edge_dates_v4: ['strategy_marginal_edge_runs_v4'],
  strategy_marginal_edge_head_v4: ['strategy_marginal_edge_runs_v4'],
  strategy_marginal_edge_v4: ['strategy_marginal_edge_runs_v4'],
  strategy_route_backfill_eligibility_v1: ['strategy_route_calibration_runs_v1'],
  strategy_route_calibration_head_v1: ['strategy_route_calibration_runs_v1'],
}

function orderShadowBackfillTables(tables: string[]): string[] {
  const tableSet = new Set(tables)
  const depthCache = new Map<string, number>()

  const depth = (table: string, visiting = new Set<string>()): number => {
    const cached = depthCache.get(table)
    if (cached !== undefined) return cached
    if (visiting.has(table)) throw new Error(`data_domain_shadow_dependency_cycle:${table}`)
    visiting.add(table)
    const parentDepths = (SHADOW_BACKFILL_DEPENDENCIES[table] ?? [])
      .filter((parent) => tableSet.has(parent))
      .map((parent) => depth(parent, visiting) + 1)
    visiting.delete(table)
    const value = parentDepths.length ? Math.max(...parentDepths) : 0
    depthCache.set(table, value)
    return value
  }

  return [...tables].sort((left, right) => depth(left) - depth(right) || left.localeCompare(right))
}


export function dataDomainForTable(tableName: string): DataDomain | null {
  const normalized = tableName.trim().toLowerCase()
  for (const [domain, tables] of Object.entries(DOMAIN_TABLES) as Array<[DataDomain, ReadonlySet<string>]>) {
    if (tables.has(normalized)) return domain
  }
  if (normalized.startsWith('paper_')) return 'paper'
  return null
}

export function tablesForDataDomain(domain: DataDomain): string[] {
  return [...DOMAIN_TABLES[domain]].sort()
}

export function tablesForDataDomainShadowBackfill(domain: DataDomain): string[] {
  const excluded = SHADOW_BACKFILL_EXCLUDED_TABLES[domain] ?? new Set<string>()
  return orderShadowBackfillTables(
    tablesForDataDomain(domain).filter((table) => !excluded.has(table)),
  )
}

function domainBindings(env: Pick<Bindings, 'DB'> & Partial<Bindings>): Partial<Record<DataDomain, D1Database | undefined>> {
  return {
    core: env.CORE_DB,
    market: env.MARKET_DB,
    learning: env.LEARNING_DB,
    ops: env.OPS_DB,
    execution: env.EXECUTION_DB,
    paper: env.PAPER_DB,
    research: env.RESEARCH_DB,
  }
}

export function activeDataDomains(env: Partial<Bindings>): Set<DataDomain> {
  const allowed = new Set<DataDomain>(DATA_DOMAINS)
  return new Set(
    String(env.MULTI_D1_ACTIVE_DOMAINS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is DataDomain => allowed.has(value as DataDomain)),
  )
}

export function invalidActiveDataDomains(env: Partial<Bindings>): string[] {
  const allowed = new Set<string>(DATA_DOMAINS)
  return String(env.MULTI_D1_ACTIVE_DOMAINS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && !allowed.has(value))
}

export function resolveDataDomainRoute(input: {
  domain: DataDomain
  activeDomains: Set<DataDomain>
  invalidDomains?: string[]
  strictRequested: boolean
  routingReady: boolean
}): 'legacy' | 'domain' {
  if (input.invalidDomains?.length) {
    throw new Error(`multi_d1_active_domain_invalid:${[...new Set(input.invalidDomains)].sort().join(',')}`)
  }
  if ((input.strictRequested || input.activeDomains.size > 0) && !input.routingReady) {
    throw new Error('multi_d1_strict_routing_not_closed')
  }
  if (input.strictRequested && input.activeDomains.size === 0) {
    throw new Error('multi_d1_strict_active_domains_missing')
  }
  return input.activeDomains.has(input.domain) ? 'domain' : 'legacy'
}

export function shadowDatabaseForDataDomain(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  domain: DataDomain,
): D1Database | null {
  return domainBindings(env)[domain] ?? null
}

export function databaseForDataDomain(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  domain: DataDomain,
): D1Database {
  const bindings = domainBindings(env)
  const active = activeDataDomains(env)
  const route = resolveDataDomainRoute({
    domain, activeDomains: active, invalidDomains: invalidActiveDataDomains(env),
    strictRequested: String(env.MULTI_D1_STRICT ?? '').toLowerCase() === 'true',
    routingReady: MULTI_D1_STRICT_ROUTING_READY,
  })
  if (route === 'legacy') return env.DB
  const selected = bindings[domain]
  if (selected) return selected
  throw new Error(`data_domain_binding_missing:${domain}`)
}
export function assertSingleDomainOwnership(tableNames: string[]): void {
  const missing = tableNames.filter((table) => !dataDomainForTable(table))
  if (missing.length) throw new Error(`unowned_data_domain_tables:${missing.sort().join(',')}`)
}
