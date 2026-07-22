import type { Bindings } from '../types'

export type DataDomain = 'core' | 'market' | 'learning' | 'ops' | 'execution' | 'paper' | 'research'

const DOMAIN_TABLES: Record<DataDomain, ReadonlySet<string>> = {
  core: new Set([
    'users', 'stocks', 'watchlist', 'risk_metrics', 'alert_rules', 'market_risk',
    'chat_sessions', 'chat_messages', 'alert_notifications', 'daily_recommendations',
  ]),
  market: new Set([
    'stock_prices', 'technical_indicators', 'financials', 'canonical_fundamental_features',
    'chip_data', 'news', 'factor_scores', 'sector_flow', 'market_breadth',
    'market_trading_sessions',
  ]),
  learning: new Set([
    'predictions', 's12_replay_trade_outcomes', 's12_structure_snapshots',
    's12_tw_calibration_runs', 's12_tw_calibration_artifacts', 'state_space_shadow_results',
    'model_accuracy', 'stock_memories', 'trade_performance', 'dataset_snapshots',
    'model_artifact_registry', 'model_champion_history', 'model_champion_pointers',
    'allocator_ev_feature_snapshots', 'allocator_ev_snapshot_runs',
    'allocator_ev_feature_snapshot_staging', 'active8_oof_cohorts',
    'active8_oof_fold_artifacts', 'active8_oof_materialized_artifacts',
    'active8_oof_predictions', 'allocator_ev_oof_snapshots', 'l4_oof_predictions',
    'strategy_spec_registry', 'strategy_decision_log', 'selection_reference_snapshots_v1',
    'strategy_label_matrix_v4', 'strategy_label_matrix_runs_v4', 'strategy_reward_ledger',
    'strategy_policy_state', 'parameter_candidate_registry', 'parameter_candidate_evidence',
    'parameter_candidate_events', 'entry_model_replay_reports',
    'canonical_selection_labels_v4', 'canonical_selection_label_rejections_v4',
    'canonical_selection_label_runs_v4', 'strategy_marginal_edge_runs_v4',
    'strategy_marginal_edge_v4', 'strategy_marginal_edge_dates_v4',
    'strategy_marginal_edge_head_v4',
    'price_horizon_labels_v1', 'price_horizon_label_rejections_v1',
  ]),
  ops: new Set([
    'system_logs', 'observability_events', 'screener_funnel_runs', 'screener_funnel_items',
    'pipeline_stage_runs', 'strategy_learning_runs', 'maintenance_task_leases',
    'legacy_migration_cursors', 'scheduler_locks', 'artifact_hard_references',
    'domain_projection_outbox', 'domain_projection_inbox', 'data_domain_cutovers',
    'data_retention_policies', 'data_retention_runs', 'storage_capacity_daily',
    'price_horizon_projection_status', 'price_horizon_projection_runs',
  ]),
  execution: new Set([
    'broker_execution_intents', 'broker_execution_legs', 'broker_execution_events',
  ]),
  paper: new Set([]),
  research: new Set([
    'input_snapshots', 'feature_versions', 'features', 'strategy_versions', 'strategies',
    'analysis_runs', 'workflow_steps', 'workflow_checkpoints', 'model_calls',
    'feature_clusters', 'gap_maps', 'hypotheses', 'candidates', 'candidate_lineage',
    'static_validation_results', 'audit_issues', 'cross_examinations', 'artifacts',
    'codex_imports', 'strategy_verdicts', 'candidate_verdicts', 'issue_verdicts',
  ]),
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

export function databaseForDataDomain(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  domain: DataDomain,
): D1Database {
  const bindings: Partial<Record<DataDomain, D1Database | undefined>> = {
    core: env.CORE_DB,
    market: env.MARKET_DB,
    learning: env.LEARNING_DB,
    ops: env.OPS_DB,
    execution: env.EXECUTION_DB,
    paper: env.PAPER_DB,
    research: env.RESEARCH_DB,
  }
  const selected = bindings[domain]
  if (selected) return selected
  if (String(env.MULTI_D1_STRICT ?? '').toLowerCase() === 'true') {
    throw new Error(`data_domain_binding_missing:${domain}`)
  }
  return env.DB
}

export function assertSingleDomainOwnership(tableNames: string[]): void {
  const missing = tableNames.filter((table) => !dataDomainForTable(table))
  if (missing.length) throw new Error(`unowned_data_domain_tables:${missing.sort().join(',')}`)
}
