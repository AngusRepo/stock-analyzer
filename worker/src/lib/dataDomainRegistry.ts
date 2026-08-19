import type { Bindings } from '../types'

export type DataDomain = 'core' | 'market' | 'learning' | 'ops' | 'execution' | 'paper' | 'research'

export type TableDisposition = 'full_scalar' | 'compact_projection' | 'active_window' | 'legacy_only'

export interface TableOwnershipMetadata {
  table: string
  domain: DataDomain
  disposition: TableDisposition
  route_ready: boolean
  shadow_ready: boolean
}

export const DATA_DOMAINS: readonly DataDomain[] = [
  'core', 'market', 'learning', 'ops', 'execution', 'paper', 'research',
]

export const LEGACY_CONTROL_PLANE_TABLES = new Set([
  'domain_projection_outbox',
  'domain_projection_inbox',
  'data_domain_cutovers',
  'data_domain_writer_epochs',
  'data_domain_table_writer_epochs',
  'data_domain_cutover_probe_receipts',
  'data_domain_cutover_probe_canary',
  'data_domain_backfill_cursors',
  'data_domain_parity_checks',
  'data_domain_control_revisions',
])

export const MULTI_D1_ROUTING_CONTRACT_GATES = {
  active_domain_ready_guard: true,
  invalid_domain_config_fail_closed: true,
  shadow_owned_registry_complete: true,
  direct_legacy_db_paths_closed: false,
  cross_domain_read_models_closed: false,
  active_read_write_readback_probes_automated: false,
  rollback_restore_probes_automated: false,
  writer_quiescence_shared_epoch_cas: false,
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

const DOMAIN_ROUTING_CONTRACT_READY = new Set<DataDomain>(['learning', 'execution', 'paper'])
const DOMAIN_PROJECTION_FREE_CLOSURE = new Set<DataDomain>(['learning', 'execution', 'paper'])

export function dataDomainRoutingContractReady(domain: DataDomain): boolean {
  return DOMAIN_ROUTING_CONTRACT_READY.has(domain)
}

export function dataDomainProjectionContractReady(domain: DataDomain): boolean {
  // Learning cross-domain reads are split by binding and joined in memory.
  // Execution owns an isolated intent/leg/event ledger through the domain client.
  // Paper reads Core/Market/Learning independently and joins in memory; its state writes remain Paper-owned.
  // None of these runtime paths requires a transactional cross-domain projection.
  return DOMAIN_PROJECTION_FREE_CLOSURE.has(domain)
}
const DOMAIN_TABLES: Record<DataDomain, ReadonlySet<string>> = {
  core: new Set([
    'users', 'stocks', 'watchlist', 'risk_metrics', 'alert_rules', 'market_risk',
    'chat_sessions', 'chat_messages', 'alert_notifications', 'daily_recommendations',
  ]),
  market: new Set([
    'stock_prices', 'technical_indicators', 'financials', 'canonical_fundamental_features',
    'canonical_revenue_observations_v2',
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
    'price_horizon_labels_v2', 'price_horizon_label_rejections_v2',
    'canonical_selection_outcomes_v1', 'strategy_evidence_metrics_v1',
    'allocator_ev_daily_lifecycle',
    'strategy_production_policy_history_v1', 'expected_return_shadow_evaluation_packets',
    'expected_return_serving_forward_evaluations',
    'expected_return_forward_guard_state',
    'adaptive_meta_policy_decisions', 'active8_oof_freshness_sla',
    'strategy_adaptive_policy_history_v2',


  ]),
  ops: new Set([
    'system_logs', 'observability_events', 'screener_funnel_runs', 'screener_funnel_items',
    'pipeline_stage_runs', 'pipeline_runs', 'canonical_run_heads', 'run_artifacts',
    'artifact_cleanup_cursors', 'artifact_cleanup_dlq',
    'compute_profile_events', 'compute_efficiency_reports', 'cost_events',
    'strategy_learning_runs', 'maintenance_task_leases',
    'legacy_migration_cursors', 'scheduler_locks', 'artifact_hard_references',
    'domain_projection_outbox', 'domain_projection_inbox', 'data_domain_cutovers',
    'data_domain_writer_epochs', 'data_domain_table_writer_epochs',
    'data_domain_cutover_probe_receipts', 'data_domain_cutover_probe_canary',
    'data_retention_policies', 'data_retention_runs', 'storage_capacity_daily',
    'price_horizon_projection_status', 'price_horizon_projection_runs',
    'price_horizon_projection_status_v2',
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

// These tables were discovered after the base domain manifests were created.
// Ownership is explicit so schema drift cannot remain invisible. shadow_ready
// means the target schema is safe for legacy-authority copy/parity; route_ready
// remains the independent live read/write cutover gate.
const DEFERRED_PRODUCTION_TABLE_OWNERSHIP: readonly TableOwnershipMetadata[] = [
  { table: 'stock_analysis_reports', domain: 'core', disposition: 'compact_projection', route_ready: false, shadow_ready: true },

  { table: 'canonical_broker_flow_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_broker_rank_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_chip_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_futures_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_institutional_amount_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_market_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_market_index_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_market_summary_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_regime_context_daily', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_revenue_monthly', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'canonical_trading_restrictions', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'concept_buzz', domain: 'market', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'external_evidence_items', domain: 'market', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'finlab_taxonomy_tags', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'margin_data', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'market_regime_factor_packets', domain: 'market', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'monthly_revenue', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'screener_momentum_snapshots', domain: 'market', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'screener_selection_history', domain: 'market', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'sector_flow_stocks', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'sector_heat', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'sector_leaders', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'shareholding', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'source_quality_metrics', domain: 'market', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'stock_profiles', domain: 'market', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'stock_tags', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'stock_theme_features', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'stock_trading_restrictions', domain: 'market', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'theme_signals', domain: 'market', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'us_market_signals', domain: 'market', disposition: 'active_window', route_ready: false, shadow_ready: true },

  { table: 'config_lifecycle_events', domain: 'learning', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'config_lifecycle_state', domain: 'learning', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'meta_reward_ledger', domain: 'learning', disposition: 'active_window', route_ready: true, shadow_ready: false },
  { table: 'meta_shadow_decisions', domain: 'learning', disposition: 'active_window', route_ready: true, shadow_ready: false },
  { table: 'model_health_daily', domain: 'learning', disposition: 'legacy_only', route_ready: false, shadow_ready: true },
  { table: 'model_lifecycle_events', domain: 'learning', disposition: 'legacy_only', route_ready: false, shadow_ready: true },
  { table: 'model_lifecycle_state', domain: 'learning', disposition: 'legacy_only', route_ready: false, shadow_ready: true },
  { table: 'persona_opinions', domain: 'learning', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'strategy_candidate_contexts', domain: 'learning', disposition: 'compact_projection', route_ready: true, shadow_ready: false },
  { table: 'strategy_threshold_calibration_artifacts', domain: 'learning', disposition: 'legacy_only', route_ready: false, shadow_ready: true },
  { table: 'strategy_threshold_calibration_runs', domain: 'learning', disposition: 'legacy_only', route_ready: false, shadow_ready: true },

  { table: 'artifact_d1_scrub_queue', domain: 'ops', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'data_source_inventory', domain: 'ops', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'finlab_backfill_runs', domain: 'ops', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'finlab_materialization_manifest', domain: 'ops', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'gap_fill_candidates', domain: 'ops', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'source_diff_report', domain: 'ops', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'source_key_attempts', domain: 'ops', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'source_key_report', domain: 'ops', disposition: 'full_scalar', route_ready: false, shadow_ready: true },
  { table: 'webhook_log', domain: 'ops', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'weekly_audit_reports', domain: 'ops', disposition: 'compact_projection', route_ready: false, shadow_ready: true },

  { table: 'risk_audit_log', domain: 'execution', disposition: 'active_window', route_ready: true, shadow_ready: true },

  { table: 'debate_memory', domain: 'paper', disposition: 'active_window', route_ready: true, shadow_ready: true },
  { table: 'decision_logs', domain: 'paper', disposition: 'active_window', route_ready: true, shadow_ready: true },
  { table: 'exit_shadow_log', domain: 'paper', disposition: 'active_window', route_ready: true, shadow_ready: true },
  { table: 'pending_buy_filter_audit', domain: 'paper', disposition: 'active_window', route_ready: true, shadow_ready: true },
  { table: 'pending_buy_items', domain: 'paper', disposition: 'active_window', route_ready: true, shadow_ready: true },
  { table: 'pending_buy_runs', domain: 'paper', disposition: 'active_window', route_ready: true, shadow_ready: true },
  { table: 'promotion_audit_events', domain: 'paper', disposition: 'active_window', route_ready: true, shadow_ready: true },

  { table: 'active_strategy_backtest_results', domain: 'research', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'backtest_results', domain: 'research', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'debate_ab_log', domain: 'research', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'monte_carlo_results', domain: 'research', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'pbo_results', domain: 'research', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'strategy_backtest_results', domain: 'research', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'strategy_mining_candidates', domain: 'research', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
  { table: 'strategy_mining_runs', domain: 'research', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'strategy_promotion_ledger', domain: 'research', disposition: 'active_window', route_ready: false, shadow_ready: true },
  { table: 'strategy_similarity_matrix', domain: 'research', disposition: 'compact_projection', route_ready: false, shadow_ready: true },
]
const SHADOW_BACKFILL_EXCLUDED_TABLES: Partial<Record<DataDomain, ReadonlySet<string>>> = {
  // Domain-native tables have no legacy source by design. They are created and
  // populated only after the split, so routing/schema readiness includes them
  // while the legacy-to-domain backfill drain must skip them.
  learning: new Set([
    'entry_model_replay_reports',
    'price_horizon_labels_v2',
    'price_horizon_label_rejections_v2',
    'canonical_selection_outcomes_v1',
    'strategy_evidence_metrics_v1',
  ]),
  market: new Set([
    // Append-only knowledge-time rows start at domain creation; mutable legacy revenue cannot seed them.
    'canonical_revenue_observations_v2',
  ]),
  ops: new Set([
    'maintenance_task_leases',
    'data_domain_cutovers',
    'data_domain_writer_epochs',
    'data_domain_table_writer_epochs',
    'data_domain_backfill_cursors',
    'data_domain_parity_checks',
    'data_domain_cutover_probe_receipts',
    'data_domain_cutover_probe_canary',
    'price_horizon_projection_status_v2',
  ]),
}

const TABLE_OWNERSHIP: readonly TableOwnershipMetadata[] = [
  ...(Object.entries(DOMAIN_TABLES) as Array<[DataDomain, ReadonlySet<string>]>).flatMap(([domain, tables]) => (
    [...tables].map((table): TableOwnershipMetadata => ({
      table,
      domain,
      disposition: 'full_scalar',
      route_ready: !LEGACY_CONTROL_PLANE_TABLES.has(table),
      shadow_ready: !LEGACY_CONTROL_PLANE_TABLES.has(table)
        && !(SHADOW_BACKFILL_EXCLUDED_TABLES[domain] ?? new Set<string>()).has(table),
    }))
  )),
  ...DEFERRED_PRODUCTION_TABLE_OWNERSHIP,
]
// Shadow copies must respect the same foreign-key topology as the legacy DB.
// Keep this map next to the ownership registry so every durable backfill path
// receives parent rows before child rows, independent of alphabetical names.
const SHADOW_BACKFILL_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  active8_oof_fold_artifacts: ['active8_oof_cohorts'],
  active8_oof_materialized_artifacts: ['active8_oof_cohorts'],
  active8_oof_predictions: ['active8_oof_cohorts'],
  alert_notifications: ['alert_rules', 'users'],
  alert_rules: ['stocks', 'users'],
  chat_messages: ['chat_sessions'],
  chat_sessions: ['stocks'],
  daily_recommendations: ['stocks'],
  risk_metrics: ['stocks'],
  watchlist: ['stocks', 'users'],
  allocator_ev_feature_snapshot_staging: ['allocator_ev_snapshot_runs'],
  allocator_ev_oof_snapshots: ['active8_oof_cohorts'],
  broker_execution_events: ['broker_execution_intents', 'broker_execution_legs'],
  broker_execution_legs: ['broker_execution_intents'],
  data_retention_cursors: ['data_retention_policies'],
  data_retention_run_items: ['data_retention_runs'],
  data_retention_runs: ['data_retention_policies'],
  expected_return_artifact_payloads: ['model_artifact_registry'],
  model_champion_history: ['model_artifact_registry'],
  model_champion_pointers: [
    'model_artifact_registry',
    'expected_return_artifact_payloads',
    'model_champion_history',
  ],
  l4_oof_predictions: ['active8_oof_cohorts'],
  s12_structure_batch_shards: ['s12_structure_batch_runs'],
  screener_funnel_items: ['screener_funnel_runs'],
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


function ownershipEntriesForTable(tableName: string): TableOwnershipMetadata[] {
  const normalized = tableName.trim().toLowerCase()
  return TABLE_OWNERSHIP.filter((entry) => entry.table === normalized)
}

export function assertOwnershipEntries(entries: readonly TableOwnershipMetadata[]): void {
  const owners = new Map<string, DataDomain[]>()
  for (const entry of entries) {
    const table = entry.table.trim().toLowerCase()
    if (!table) throw new Error('data_domain_ownership_table_empty')
    const domains = owners.get(table) ?? []
    domains.push(entry.domain)
    owners.set(table, domains)
  }
  const duplicates = [...owners.entries()]
    .filter(([, domains]) => domains.length !== 1)
    .map(([table, domains]) => `${table}:${domains.sort().join('|')}`)
    .sort()
  if (duplicates.length) throw new Error(`duplicate_data_domain_ownership:${duplicates.join(',')}`)
}

export function tableOwnershipMetadata(tableName: string): TableOwnershipMetadata | null {
  const entries = ownershipEntriesForTable(tableName)
  if (entries.length > 1) {
    throw new Error(`duplicate_data_domain_ownership:${tableName.trim().toLowerCase()}:${entries.map((entry) => entry.domain).sort().join('|')}`)
  }
  return entries[0] ?? null
}

export function dataDomainForTable(tableName: string): DataDomain | null {
  return tableOwnershipMetadata(tableName)?.domain ?? null
}

export function tablesForDataDomain(domain: DataDomain): string[] {
  return [...new Set(TABLE_OWNERSHIP.filter((entry) => entry.domain === domain).map((entry) => entry.table))].sort()
}

export function tablesForDataDomainRouteReady(domain: DataDomain): string[] {
  return TABLE_OWNERSHIP
    .filter((entry) => entry.domain === domain && entry.route_ready)
    .map((entry) => entry.table)
    .sort()
}

export function tablesForDataDomainShadowBackfill(domain: DataDomain): string[] {
  return orderShadowBackfillTables(
    TABLE_OWNERSHIP
      .filter((entry) => entry.domain === domain && entry.shadow_ready)
      .map((entry) => entry.table),
  )
}

export function dependentTablesForDataDomainShadowBackfill(
  domain: DataDomain,
  parentTable: string,
): string[] {
  const owned = new Set(tablesForDataDomainShadowBackfill(domain))
  return tablesForDataDomainShadowBackfill(domain)
    .filter((table) => (
      owned.has(table)
      && (SHADOW_BACKFILL_DEPENDENCIES[table] ?? []).includes(parentTable)
    ))
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
  if (input.activeDomains.has(input.domain) && !input.routingReady) {
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
    routingReady: dataDomainRoutingContractReady(domain),
  })
  if (route === 'legacy') return env.DB
  const selected = bindings[domain]
  if (selected) return selected
  throw new Error(`data_domain_binding_missing:${domain}`)
}

export function databaseForTable(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  tableName: string,
): D1Database {
  const table = tableName.trim().toLowerCase()
  if (LEGACY_CONTROL_PLANE_TABLES.has(table)) return env.DB
  const ownership = tableOwnershipMetadata(table)
  if (!ownership) throw new Error(`unowned_data_domain_table:${table}`)
  if (!ownership.route_ready) return env.DB
  return databaseForDataDomain(env, ownership.domain)
}
export function assertSingleDomainOwnership(tableNames: string[]): void {
  assertOwnershipEntries(TABLE_OWNERSHIP)
  const missing = [...new Set(tableNames.map((table) => table.trim().toLowerCase()))]
    .filter((table) => ownershipEntriesForTable(table).length === 0)
    .sort()
  if (missing.length) throw new Error(`unowned_data_domain_tables:${missing.join(',')}`)
}
