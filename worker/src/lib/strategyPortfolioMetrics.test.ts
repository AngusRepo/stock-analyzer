import {
  buildStrategyPortfolioBacktestMetricOverrides,
  buildStrategyPortfolioDecisionLogMetricOverrides,
  buildStrategyPortfolioMetricOverridesFromLedgerRows,
  coerceModalStrategySimilarityGraphEvidence,
  modalStrategySimilarityBlockedReason,
  loadStrategyPortfolioMetricOverrides,
  rewardLedgerRowToStrategyPortfolioMetrics,
  type StrategyBacktestResultMetricRow,
  type StrategyDecisionLogMetricRow,
  type StrategyRewardLedgerMetricRow,
} from './strategyPortfolioMetrics'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function row(input: Partial<StrategyRewardLedgerMetricRow> & { strategy_id: string }): StrategyRewardLedgerMetricRow {
  return {
    strategy_id: input.strategy_id,
    strategy_version: input.strategy_version ?? 'strategy-spec-v1',
    strategy_status: input.strategy_status ?? 'active',
    alpha_bucket: input.alpha_bucket ?? 'trend_following',
    horizon_days: input.horizon_days ?? 5,
    samples: input.samples ?? 30,
    hit_rate: input.hit_rate ?? 0.6,
    avg_return_pct: input.avg_return_pct ?? 0.012,
    reward_sum: input.reward_sum ?? null,
    max_drawdown_pct: input.max_drawdown_pct ?? -0.04,
    coverage: input.coverage ?? 0.8,
    market_segment: input.market_segment ?? 'all',
    regime: input.regime ?? 'all',
    evidence_json: input.evidence_json ?? '{}',
    updated_at: input.updated_at ?? '2026-06-14T00:00:00.000Z',
  }
}

function metricLineage(): Record<string, unknown> {
  return {
    metric_contract_version: 'strategy-performance-metrics-v2',
    artifact_id: 'strategy-metrics-test-artifact',
    as_of_date: '2026-06-14',
    pit_fenced: true,
    payload_checksum: 'a'.repeat(64),
  }
}

function decisionRow(input: StrategyDecisionLogMetricRow): StrategyDecisionLogMetricRow {
  return input
}

function backtestRow(input: Partial<StrategyBacktestResultMetricRow> & { strategy: string }): StrategyBacktestResultMetricRow {
  return {
    run_date: input.run_date ?? '2026-06-14',
    strategy: input.strategy,
    timerange: input.timerange ?? '2026-01-01~2026-06-01',
    total_trades: input.total_trades ?? 72,
    win_rate: input.win_rate ?? 0.61,
    sharpe: input.sharpe ?? 1.22,
    sortino: input.sortino ?? 1.45,
    calmar: input.calmar ?? 0.9,
    max_drawdown: input.max_drawdown ?? 0.11,
    cagr: input.cagr ?? 0.24,
    profit_factor: input.profit_factor ?? 1.35,
    expectancy: input.expectancy ?? 0.012,
    raw_results: input.raw_results ?? '{}',
    created_at: input.created_at ?? '2026-06-14T00:00:00.000Z',
  }
}

function fakeDb(input: {
  ledgerRows?: StrategyRewardLedgerMetricRow[]
  decisionRows?: StrategyDecisionLogMetricRow[]
  backtestRows?: StrategyBacktestResultMetricRow[]
  error?: Error
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              ;(fakeDb as any).lastSql = sql
              ;(fakeDb as any).sqls = [...((fakeDb as any).sqls ?? []), sql]
              ;(fakeDb as any).lastArgs = args
              if (input.error) throw input.error
              if (sql.includes('FROM strategy_reward_ledger')) return { results: input.ledgerRows ?? [] }
              if (sql.includes('FROM strategy_decision_log')) return { results: input.decisionRows ?? [] }
              if (sql.includes('FROM backtest_results')) return { results: input.backtestRows ?? [] }
              return { results: [] }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

{
  const metrics = rewardLedgerRowToStrategyPortfolioMetrics(row({
    strategy_id: 'reliable_low_corr_v1',
    samples: 60,
    hit_rate: 0.64,
    avg_return_pct: 0.018,
    max_drawdown_pct: -0.035,
    coverage: 0.9,
    evidence_json: JSON.stringify({
      strategy_performance_metric_lineage: metricLineage(),
      rolling_sharpe: 1.1,
      reliability: 0.82,
      return_correlation: 0.12,
      holding_overlap: 0.08,
      factor_return: 0.021,
      factor_crowding: 0.1,
      centrality: 0.22,
      live_backtest_divergence: 0.04,
    }),
  }))
  assert(metrics.rolling_sharpe === 1.1, 'only immutable exact Sharpe may enter the strategy route')
  assert(metrics.max_drawdown === 0.035, 'drawdown should be normalized to positive risk magnitude')
  assert(metrics.reliability === 0.82, 'only immutable exact reliability may enter the strategy route')
  assert(metrics.return_correlation === 0.12, 'evidence_json should pass through return correlation')
  assert(metrics.holding_overlap === 0.08, 'evidence_json should pass through holding overlap')
  assert(metrics.factor_return === 0.021, 'evidence_json should pass through FinLab factor return')
  assert(metrics.centrality === 0.22, 'evidence_json should pass through graph/factor centrality')
}

{
  const metrics = rewardLedgerRowToStrategyPortfolioMetrics(row({
    strategy_id: 'thin_samples_v1',
    samples: 2,
    hit_rate: 1,
    avg_return_pct: 0.05,
    max_drawdown_pct: 0,
    coverage: 1,
  }))
  assert(metrics.strategy_metric_status === 'no_evidence', 'summary-only thin evidence must be unavailable')
  assert(metrics.rolling_sharpe == null && metrics.ic == null && metrics.shapley_contribution == null, 'hit rate and mean return must never manufacture formal statistics')
}

{
  const overrides = buildStrategyPortfolioMetricOverridesFromLedgerRows([
    row({ strategy_id: 'regime_sensitive_v1', regime: 'all', hit_rate: 0.51, avg_return_pct: 0.001, samples: 80 }),
    row({ strategy_id: 'regime_sensitive_v1', regime: 'bull', hit_rate: 0.7, avg_return_pct: 0.025, samples: 20 }),
    row({ strategy_id: 'too_thin_v1', samples: 2, hit_rate: 0.9 }),
  ], { regime: 'bull', minSamples: 5 })
  assert(overrides.regime_sensitive_v1 != null, 'loader should build an override for eligible strategy rows')
  assert(overrides.regime_sensitive_v1.strategy_metric_status === 'no_evidence', 'reward summary without immutable metric lineage must stay unavailable')
  assert(overrides.too_thin_v1 == null, 'rows below minSamples must not feed L1.25 priors')
}

{
  const overrides = buildStrategyPortfolioMetricOverridesFromLedgerRows([
    row({ strategy_id: 'segmented_v1', market_segment: 'TWSE', samples: 3, hit_rate: 2 / 3, avg_return_pct: 0.02, reward_sum: 0.06 }),
    row({ strategy_id: 'segmented_v1', market_segment: 'OTC', samples: 7, hit_rate: 3 / 7, avg_return_pct: -0.01, reward_sum: -0.07 }),
  ], { marketSegment: 'all', minSamples: 5 })
  assert(overrides.segmented_v1.metric_sample_count === 10, 'all-market loader must aggregate TWSE/OTC samples before applying minSamples')
  assert(overrides.segmented_v1.recent_alpha == null, 'sample-weighted average return must not be relabeled as alpha')
}

{
  const overrides = buildStrategyPortfolioMetricOverridesFromLedgerRows([
    row({ strategy_id: 'canonical_all_v1', market_segment: 'all', samples: 20, avg_return_pct: 0.03 }),
    row({ strategy_id: 'canonical_all_v1', market_segment: 'TWSE', samples: 100, avg_return_pct: -0.02 }),
  ], { marketSegment: 'all', minSamples: 5 })
  assert(overrides.canonical_all_v1.metric_sample_count === 20, 'canonical all-market row must win over segment rows to prevent double counting')
  assert(overrides.canonical_all_v1.recent_alpha == null, 'canonical average return is not formal alpha without immutable lineage')
}

{
  const overrides = buildStrategyPortfolioMetricOverridesFromLedgerRows([
    row({ strategy_id: 'latest_materialization_v1', market_segment: 'TWSE', samples: 100, avg_return_pct: -0.02, updated_at: '2026-07-27T00:00:00.000Z' }),
    row({ strategy_id: 'latest_materialization_v1', market_segment: 'TWSE', samples: 20, avg_return_pct: 0.015, updated_at: '2026-07-28T00:00:00.000Z' }),
  ], { marketSegment: 'all', minSamples: 5 })
  assert(overrides.latest_materialization_v1.metric_sample_count === 20, 'latest legal segment materialization must win over an older larger row')
  assert(overrides.latest_materialization_v1.recent_alpha == null, 'latest average return is still not formal alpha')
}

{
  const raw = {
    strategy_id: 'reliable_low_corr_v1',
    strategy_performance_metric_lineage: metricLineage(),
    reliability: 0.8,
    strategy_returns_by_partition: {
      reliable_low_corr_v1: [0.02, 0.01, 0.03, 0.025],
      crowded_low_sharpe_v1: [0.02, -0.01, 0.04, -0.005],
    },
    per_regime: {
      bull: { return: 0.08 },
    },
    walk_forward: { passed: true, windows: 6, oos_sharpe: 1.1 },
  }
  const overrides = buildStrategyPortfolioBacktestMetricOverrides([
    backtestRow({ strategy: 'replay_mode_b', raw_results: JSON.stringify(raw), sharpe: 1.4, max_drawdown: 0.09 }),
    backtestRow({ strategy: 'replay_mode_b', raw_results: JSON.stringify({ summary: { sharpe: 2.5 } }) }),
  ], { regime: 'bull', knownStrategyIds: ['reliable_low_corr_v1', 'crowded_low_sharpe_v1'] })
  assert(overrides.reliable_low_corr_v1 != null, 'explicit strategy_id in backtest raw_results should map to L1.25 metrics')
  assert(overrides.replay_mode_b == null, 'global replay rows must not become fake strategy priors')
  assert(overrides.reliable_low_corr_v1.rolling_sharpe === 1.4, 'backtest sharpe should fill rolling sharpe when ledger is absent')
  assert(overrides.reliable_low_corr_v1.max_drawdown === 0.09, 'backtest MDD should fill max_drawdown when ledger is absent')
  assert(overrides.reliable_low_corr_v1.regime_performance === 0.08, 'backtest per-regime return should feed regime performance')
  assert((overrides.reliable_low_corr_v1.reliability ?? 0) > 0.5, 'walk-forward-backed backtest should raise reliability')
}

{
  const overrides = buildStrategyPortfolioDecisionLogMetricOverrides([
    decisionRow({ date: '2026-06-10', symbol: '2330', strategy_id: 'trend_a_v1', alpha_bucket: 'trend_following', match_score: 0.8 }),
    decisionRow({ date: '2026-06-10', symbol: '2317', strategy_id: 'trend_a_v1', alpha_bucket: 'trend_following', match_score: 0.7 }),
    decisionRow({ date: '2026-06-11', symbol: '2330', strategy_id: 'trend_a_v1', alpha_bucket: 'trend_following', match_score: 0.75 }),
    decisionRow({ date: '2026-06-11', symbol: '2454', strategy_id: 'trend_a_v1', alpha_bucket: 'trend_following', match_score: 0.7 }),
    decisionRow({ date: '2026-06-10', symbol: '2330', strategy_id: 'trend_b_v1', alpha_bucket: 'trend_following', match_score: 0.82 }),
    decisionRow({ date: '2026-06-10', symbol: '2317', strategy_id: 'trend_b_v1', alpha_bucket: 'trend_following', match_score: 0.78 }),
    decisionRow({ date: '2026-06-10', symbol: '9999', strategy_id: 'quality_c_v1', alpha_bucket: 'breakout_vol_expansion', match_score: 0.65 }),
  ])
  assert(overrides.trend_a_v1.holding_overlap === 0.6667, 'decision log should compute strategy holding overlap by symbol Jaccard')
  assert(overrides.trend_a_v1.turnover === 0.6667, 'decision log should compute day-to-day strategy turnover')
  assert((overrides.trend_a_v1.factor_crowding ?? 0) > (overrides.quality_c_v1.factor_crowding ?? 1), 'same-bucket overlap should raise factor crowding')
  assert((overrides.trend_a_v1.centrality ?? 0) > 0, 'decision log should compute centrality-like crowding evidence')
}

{
  const evidence = coerceModalStrategySimilarityGraphEvidence({
    status: 'computed',
    source: 'modal_python',
    algorithm_owner: 'ml-service-modal-python',
    method: 'networkx_connected_components_oof_residual_correlation',
    input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
    medoid_algorithm: "sklearn_extra.cluster.KMedoids(method='pam')",
    kmedoids_pam_preflight_status: 'pass',
    kmedoids_pam_preflight: { status: 'pass' },
    global_k_hardcoded: false,
    production_selector: false,
    self_implemented_algorithm: false,
    strategy_count: 2,
    edge_count: 1,
    component_count: 1,
    effective_strategy_count: 1,
    edge_threshold: 0.6,
    edge_threshold_source: 'adaptive_quantile',
    eligible_oof_pair_count: 1,
    paired_date_max: 8,
    oof_max_date: '2026-07-08',
    strategy_cluster_id: { alpha_a: 'sc000', alpha_b: 'sc000' },
    strategy_cluster_size: { alpha_a: 2, alpha_b: 2 },
    strategy_cluster_crowding_score: { alpha_a: 0.5, alpha_b: 0.5 },
    strategy_cluster_uniqueness_score: { alpha_a: 0.5, alpha_b: 0.5 },
  })
  assert(evidence?.method === 'networkx_connected_components_oof_residual_correlation', 'Worker must accept the mature OOF residual similarity contract')
  assert(evidence?.eligible_oof_pair_count === 1, 'Worker must retain OOF pair coverage diagnostics')
  assert(evidence?.paired_date_max === 8 && evidence?.oof_max_date === '2026-07-08', 'Worker must retain OOF maturity diagnostics')
}

{
  const blocked = {
    status: 'blocked',
    source: 'modal_python',
    algorithm_owner: 'ml-service-modal-python',
    method: 'networkx_connected_components_oof_residual_correlation',
    input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
    medoid_algorithm: "sklearn_extra.cluster.KMedoids(method='pam')",
    global_k_hardcoded: false,
    production_selector: false,
    self_implemented_algorithm: false,
    strategy_count: 2,
    eligible_oof_pair_count: 0,
    blocked_reason: 'insufficient_paired_mature_oof_residual_returns',
    strategy_cluster_id: { alpha_a: 'sc000', alpha_b: 'sc001' },
  }
  assert(
    modalStrategySimilarityBlockedReason(blocked) === 'insufficient_paired_mature_oof_residual_returns',
    'valid fail-closed Modal evidence must retain its blocked reason',
  )
  assert(
    coerceModalStrategySimilarityGraphEvidence(blocked) === null,
    'blocked evidence must never be accepted as formal router evidence',
  )
  assert(
    modalStrategySimilarityBlockedReason({ ...blocked, production_selector: true }) === null,
    'unsafe blocked evidence must remain schema-invalid',
  )
}
async function main(): Promise<void> {
  {
    const db = fakeDb({
      ledgerRows: [row({ strategy_id: 'ledger_strategy_v1', hit_rate: 0.62, samples: 40 })],
      backtestRows: [backtestRow({
        strategy: 'backtest_only_strategy_v1',
        raw_results: JSON.stringify({ strategy_id: 'backtest_only_strategy_v1', strategy_performance_metric_lineage: metricLineage(), reliability: 0.8, walk_forward: { passed: true, windows: 5 } }),
      })],
    })
    const result = await loadStrategyPortfolioMetricOverrides(db, {
      regime: 'bull',
      marketSegment: 'all',
      minSamples: 5,
      evidenceMode: 'live_current',
      asOfDate: '2026-08-24',
      knownStrategyIds: ['ledger_strategy_v1', 'backtest_only_strategy_v1', 'missing_strategy_v1'],
    })
    assert(result.status === 'loaded', 'D1 loader should report loaded when ledger rows produce metrics')
    assert(result.telemetry.source === 'strategy_reward_ledger+strategy_decision_log+backtest_results', 'loader telemetry should declare source tables')
    assert(result.telemetry.backtest_result_row_count === 1, 'loader telemetry should count backtest rows')
    assert(result.telemetry.backtest_metric_count === 1, 'loader telemetry should count mapped backtest strategy metrics')
    assert(result.telemetry.metric_count === 3, 'loader telemetry should cover every known strategy, not only strategies with live evidence')
    assert(result.telemetry.live_metric_count === 1, 'summary-only ledger rows must not count as formal performance evidence')
    assert(result.telemetry.known_strategy_count === 3, 'loader telemetry should expose known strategy coverage denominator')
    assert(result.telemetry.missing_metric_count === 2, 'missing immutable lineage must count as missing performance evidence')
    assert(result.telemetry.metric_status_counts.no_evidence === 2, 'known strategy and summary-only ledger must be explicit no_evidence')
    assert(result.metrics.ledger_strategy_v1 != null, 'loader should return metric override keyed by strategy id')
    assert(result.metrics.backtest_only_strategy_v1 != null, 'loader should include explicitly mapped backtest-only strategy metrics')
    assert(result.metrics.missing_strategy_v1.strategy_metric_status === 'no_evidence', 'missing known strategy should be shrunk, not omitted from L1.25')
    assert((result.metrics.missing_strategy_v1.reliability ?? 1) < 0.5, 'missing known strategy should receive conservative reliability shrinkage')
    const executedSql = ((fakeDb as any).sqls ?? []).join('\n')
    assert(executedSql.includes("selection_contract_version = 'selection-reference-snapshot-v3'"), 'reward reader must reject legacy selection contracts')
    assert(executedSql.includes('date_end < ?'), 'reward reader must fence labels strictly before the scored date')
    assert(executedSql.includes('run_date <= ?'), 'live-current backtest evidence must be known by the scored date')
    assert(executedSql.includes("? = 'all' OR market_segment = ?"), 'all-market reward reader must use a true wildcard before sample-weighted aggregation')
    assert(executedSql.includes("evaluation_contract_version = 'strategy-evaluation-v2'"), 'decision reader must reject legacy evaluation contracts')
    assert(executedSql.includes('ROW_NUMBER() OVER') && executedSql.includes('PARTITION BY strategy_id'), 'decision evidence must use per-strategy balance instead of a global LIMIT')
  }

  {
    ;(fakeDb as any).sqls = []
    const historicalDb = fakeDb({
      ledgerRows: [row({ strategy_id: 'pit_strategy_v1', hit_rate: 0.55, samples: 20 })],
      backtestRows: [backtestRow({ strategy: 'future_backtest_v1', run_date: '2026-08-24' })],
    })
    await loadStrategyPortfolioMetricOverrides(historicalDb, {
      regime: 'bull',
      evidenceMode: 'historical_replay',
      asOfDate: '2026-08-04',
      knownStrategyIds: ['pit_strategy_v1'],
    })
    const historicalSql = ((fakeDb as any).sqls ?? []).join('\n')
    assert(!historicalSql.includes('FROM backtest_results'), 'historical replay must never read current backtest evidence')
  }

  {
    const db = fakeDb({ error: new Error('no such table: strategy_reward_ledger') })
    const result = await loadStrategyPortfolioMetricOverrides(db, { regime: 'bull' })
    assert(result.status === 'unavailable', 'missing ledger table should degrade to unavailable, not throw')
    assert(Object.keys(result.metrics).length === 0, 'unavailable loader should return empty metrics')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
