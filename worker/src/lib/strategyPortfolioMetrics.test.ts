import {
  buildStrategyPortfolioBacktestMetricOverrides,
  buildStrategyPortfolioDecisionLogMetricOverrides,
  buildStrategyPortfolioMetricOverridesFromLedgerRows,
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
      return_correlation: 0.12,
      holding_overlap: 0.08,
      factor_crowding: 0.1,
      live_backtest_divergence: 0.04,
    }),
  }))
  assert((metrics.rolling_sharpe ?? 0) > 0, 'positive reward ledger should map to positive rolling sharpe')
  assert(metrics.max_drawdown === 0.035, 'drawdown should be normalized to positive risk magnitude')
  assert((metrics.reliability ?? 0) > 0.5, 'sample-backed positive ledger should raise reliability')
  assert(metrics.return_correlation === 0.12, 'evidence_json should pass through return correlation')
  assert(metrics.holding_overlap === 0.08, 'evidence_json should pass through holding overlap')
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
  assert((metrics.reliability ?? 1) < 0.6, 'thin samples should shrink reliability toward neutral')
}

{
  const overrides = buildStrategyPortfolioMetricOverridesFromLedgerRows([
    row({ strategy_id: 'regime_sensitive_v1', regime: 'all', hit_rate: 0.51, avg_return_pct: 0.001, samples: 80 }),
    row({ strategy_id: 'regime_sensitive_v1', regime: 'bull', hit_rate: 0.7, avg_return_pct: 0.025, samples: 20 }),
    row({ strategy_id: 'too_thin_v1', samples: 2, hit_rate: 0.9 }),
  ], { regime: 'bull', minSamples: 5 })
  assert(overrides.regime_sensitive_v1 != null, 'loader should build an override for eligible strategy rows')
  assert((overrides.regime_sensitive_v1.reliability ?? 0) > 0.5, 'regime-specific positive row should be preferred over generic row')
  assert(overrides.too_thin_v1 == null, 'rows below minSamples must not feed L1.25 priors')
}

{
  const raw = {
    strategy_id: 'reliable_low_corr_v1',
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
}

async function main(): Promise<void> {
  {
    const db = fakeDb({
      ledgerRows: [row({ strategy_id: 'ledger_strategy_v1', hit_rate: 0.62, samples: 40 })],
      backtestRows: [backtestRow({
        strategy: 'backtest_only_strategy_v1',
        raw_results: JSON.stringify({ strategy_id: 'backtest_only_strategy_v1', walk_forward: { passed: true, windows: 5 } }),
      })],
    })
    const result = await loadStrategyPortfolioMetricOverrides(db, {
      regime: 'bull',
      marketSegment: 'all',
      minSamples: 5,
      knownStrategyIds: ['ledger_strategy_v1', 'backtest_only_strategy_v1'],
    })
    assert(result.status === 'loaded', 'D1 loader should report loaded when ledger rows produce metrics')
    assert(result.telemetry.source === 'strategy_reward_ledger+strategy_decision_log+backtest_results', 'loader telemetry should declare source tables')
    assert(result.telemetry.backtest_result_row_count === 1, 'loader telemetry should count backtest rows')
    assert(result.telemetry.backtest_metric_count === 1, 'loader telemetry should count mapped backtest strategy metrics')
    assert(result.telemetry.metric_count === 2, 'loader telemetry should count merged strategy metric overrides')
    assert(result.metrics.ledger_strategy_v1 != null, 'loader should return metric override keyed by strategy id')
    assert(result.metrics.backtest_only_strategy_v1 != null, 'loader should include explicitly mapped backtest-only strategy metrics')
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
