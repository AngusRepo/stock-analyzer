import {
  DEFAULT_STRATEGY_SPECS,
  MONTHLY_REVENUE_PIT_UNAVAILABLE_REASON,
  resolveLegacyMonthlyRevenueEvidence,
} from './strategySpec'
import * as fs from 'node:fs'
import {
  applyStrategyAdaptivePolicyThresholds,
  buildStrategyAdaptivePolicyState,
  buildStrategyDecisionRows,
  buildStrategyRewardDailyStatsRows,
  buildStrategyRewardLedgerRows,
  hydrateStrategyCandidateDailyFeatures,
  evaluateStrategyPromotionGate,
  listStrategySpecsForLearning,
  projectStrategyReplacementCandidatePrefilters,
  projectStrategyReplacementDecisionSummary,
  projectStrategyReplacementRunEvidence,
  registryRowToStrategySpec,
  seedDefaultStrategySpecRegistry,
  shouldRetireStaleStrategyRewardRows,
  summarizeDateClusteredReturns,
  strategySpecToRegistryRow,
  type StrategySpecRegistryRow,
  type StrategyLearningSummary,
} from './strategyLearning'
import { STRATEGY_REPLACEMENT_POLICY_V7 } from './strategyMarginalEdgeV4'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function strategyLearningEvidence(
  overrides: Partial<StrategyLearningSummary['specs'][number]['learning']> = {},
): StrategyLearningSummary['specs'][number]['learning'] {
  return {
    evidence_available: true,
    reward_owner: 'selection_edge_v4',
    reward_unit: 'return_fraction',
    reward_cost_basis: 'net_after_roundtrip_cost',
    decisions: 800,
    evaluable_decisions: 760,
    unavailable_decisions: 40,
    matched: 240,
    match_rate: 0.3,
    today_decisions: 0,
    today_evaluable_decisions: 0,
    today_unavailable_decisions: 0,
    today_matched: 0,
    rolling_decisions: 80,
    rolling_evaluable_decisions: 76,
    rolling_unavailable_decisions: 4,
    rolling_matched: 24,
    rolling_match_rate: 0.3,
    rolling_sessions: 12,
    samples: 450,
    hit_rate: 0.62,
    avg_return_pct: 0.018,
    max_drawdown_pct: -0.03,
    rolling_samples: 45,
    rolling_hit_rate: 0.62,
    rolling_avg_return_pct: 0.018,
    first_decision_date: '2026-04-20',
    first_matched_date: '2026-04-21',
    mature_label_max_date: '2026-05-12',
    reward_state: 'ready',
    reward_status_reason: 'reward evidence available through 2026-05-12',
    rolling_max_drawdown_pct: -0.03,
    rolling_reward_dates: 12,
    rolling_date_return_mean: 0.018,
    rolling_date_return_lcb90: 0.006,
    latest_decision_date: '2026-05-19',
    latest_reward_date: '2026-05-12',
    status: 'learning',
    ...overrides,
  }
}
function strategyReplacementGateEvidence(): StrategyLearningSummary['replacement_gate'] {
  return {
    policy: STRATEGY_REPLACEMENT_POLICY_V7,
    evidence_status: 'pending',
    status_reason: 'test fixture has no paired replacement run',
    latest_run: null,
    candidate_prefilters: [],
    decisions: [],
  }
}

function acceptedStrategyReplacementGate(
  candidateStrategyId: string,
  candidateStrategyVersion: string,
): StrategyLearningSummary['replacement_gate'] {
  return {
    ...strategyReplacementGateEvidence(),
    evidence_status: 'ready',
    status_reason: 'test fixture has accepted Atomic V7 paired replacement evidence',
    decisions: [{
      decision_id: 'atomic-v7-test:candidate:incumbent-test',
      run_id: 'atomic-v7-test',
      as_of_date: '2026-05-19',
      candidate_strategy_id: candidateStrategyId,
      candidate_strategy_version: candidateStrategyVersion,
      replaced_strategy_id: 'incumbent-test',
      replaced_strategy_version: 'v1',
      candidate_family_id: 'technical_trend',
      incumbent_family_id: 'technical_trend',
      replacement_scope: 'same_family',
      status: 'accepted',
      paired_dates: 40,
      paired_delta_mean: 0.004,
      paired_delta_lcb90: 0.001,
      statistical_policy_version: 'strategy-replacement-policy-v7-hac4-holm-power80-v1',
      hac_lag: 4,
      effective_paired_dates: 34.5,
      paired_delta_hac_standard_error: 0.001,
      paired_delta_lcb95_hac: 0.002,
      paired_delta_one_sided_p_value: 0.01,
      paired_delta_power_at_minimum_economic_delta: 0.82,
      minimum_economic_delta: 0.001,
      candidate_absolute_cost_net_mean: 0.006,
      candidate_absolute_effective_dates: 35,
      candidate_absolute_hac_standard_error: 0.0012,
      candidate_absolute_cost_net_lcb95_hac: 0.003,
      holm_family_size: 6,
      holm_rank: 1,
      holm_local_alpha: 0.008333333333333333,
      holm_adjusted_p_value: 0.04,
      holm_rejected: true,
      candidate_max_drawdown: -0.04,
      incumbent_max_drawdown: -0.05,
      candidate_turnover: 0.3,
      incumbent_turnover: 0.3,
      return_correlation: 0.7,
      rejection_reasons: [],
      promotion_allowed: true,
    }],
  }
}

function candidatePrefilterGate(
  candidateStrategyId: string,
  candidateStrategyVersion: string,
  productionEligible: boolean,
): StrategyLearningSummary['replacement_gate'] {
  const gate = acceptedStrategyReplacementGate(candidateStrategyId, candidateStrategyVersion)
  return {
    ...gate,
    status_reason: 'test fixture has ready Atomic V7 Candidate prefilter evidence without a pair',
    candidate_prefilters: [{
      strategy_id: candidateStrategyId,
      strategy_version: candidateStrategyVersion,
      evidence_status: 'ready',
      observation_dates: 40,
      candidate_observations: 120,
      marginal_edge_mean: productionEligible ? 0.004 : -0.002,
      marginal_edge_lcb90: productionEligible ? 0.001 : -0.004,
      absolute_hit_return_mean: productionEligible ? 0.006 : -0.001,
      production_eligible: productionEligible,
      production_weight_raw: productionEligible ? 0.25 : 0,
    }],
    decisions: [],
  }
}

{
  const candidateKeys = new Set(['candidate-v7|v1', 'candidate-missing|v9'])
  const prefilters = projectStrategyReplacementCandidatePrefilters([
    {
      strategy_id: 'candidate-v7',
      strategy_version: 'v1',
      observation_dates: '38',
      candidate_observations: 124,
      marginal_edge_mean: '0.0042',
      marginal_edge_lcb90: 0.0013,
      absolute_hit_return_mean: 0.0061,
      production_eligible: 1,
      production_weight_raw: '0.28',
    },
    {
      strategy_id: 'active-v7',
      strategy_version: 'v2',
      observation_dates: 41,
      candidate_observations: 180,
      marginal_edge_mean: 0.005,
      marginal_edge_lcb90: 0.002,
      absolute_hit_return_mean: 0.007,
      production_eligible: 1,
      production_weight_raw: 0.72,
    },
  ], candidateKeys)
  assert(prefilters.length === 2, 'Candidate prefilter projection must cover every Candidate key while excluding Active keys')
  assert(prefilters[0].strategy_id === 'candidate-v7' && prefilters[0].strategy_version === 'v1', 'Candidate prefilter projection must preserve strategy identity')
  assert(prefilters[0].evidence_status === 'ready', 'persisted Candidate edge rows must be marked ready')
  assert(prefilters[0].observation_dates === 38 && prefilters[0].candidate_observations === 124, 'Candidate prefilter projection must preserve evidence counts')
  assert(prefilters[0].marginal_edge_mean === 0.0042 && prefilters[0].marginal_edge_lcb90 === 0.0013, 'Candidate prefilter projection must expose marginal-edge actuals')
  assert(prefilters[0].absolute_hit_return_mean === 0.0061, 'Candidate prefilter projection must expose absolute return actuals')
  assert(prefilters[0].production_eligible === true && prefilters[0].production_weight_raw === 0.28, 'Candidate prefilter projection must expose eligibility and raw weight')
  assert(prefilters[1].strategy_id === 'candidate-missing' && prefilters[1].strategy_version === 'v9', 'missing Candidate edge rows must retain registry identity')
  assert(prefilters[1].evidence_status === 'missing', 'missing Candidate edge rows must be explicit rather than silently omitted')
  assert(prefilters[1].observation_dates === 0 && prefilters[1].candidate_observations === 0, 'missing Candidate counts must use zero defaults')
  assert(prefilters[1].marginal_edge_mean === null && prefilters[1].marginal_edge_lcb90 === null, 'missing Candidate metrics must remain nullable')
  assert(prefilters[1].production_eligible === null && prefilters[1].production_weight_raw === 0, 'missing Candidate eligibility must not be projected as a failed boolean')
  assert(projectStrategyReplacementCandidatePrefilters(prefilters.map((row) => ({
    ...row,
    production_eligible: row.production_eligible ? 1 : 0,
  })), new Set()).length === 0, 'empty Candidate key sets must project no prefilter rows')
}

{
  const decision = projectStrategyReplacementDecisionSummary({
    decision_id: 'decision-v7-1',
    run_id: 'run-v7-1',
    as_of_date: '2026-08-28',
    family_id: 'TREND_RECLAIM_CONTINUATION',
    candidate_strategy_id: 'candidate-v7',
    candidate_strategy_version: 'v1',
    replaced_strategy_id: 'incumbent-v7',
    replaced_strategy_version: 'v2',
    status: 'proposed',
    paired_dates: 42,
    paired_delta_mean: 0.004,
    paired_delta_lcb90: 0.001,
    candidate_absolute_mean: 0.006,
    candidate_max_drawdown: -0.04,
    replaced_max_drawdown: -0.05,
    candidate_turnover: 0.3,
    replaced_turnover: 0.27,
    return_correlation: 0.72,
    evidence_json: JSON.stringify({
      statistical_policy_version: 'strategy-replacement-policy-v7-hac4-holm-power80-v1',
      hac_lag: 4,
      effective_paired_dates: 35.5,
      paired_delta_hac_standard_error: 0.0011,
      paired_delta_lcb95_hac: 0.0022,
      paired_delta_one_sided_p_value: 0.012,
      paired_delta_power_at_minimum_economic_delta: 0.83,
      candidate_absolute_effective_dates: 36.5,
      candidate_absolute_hac_standard_error: 0.0013,
      candidate_absolute_lcb95_hac: 0.0031,
      minimum_economic_delta: 0.001,
      holm_family_size: 8,
      holm_rank: 2,
      holm_critical_alpha: 0.007142857142857143,
      holm_adjusted_p_value: 0.048,
      holm_rejected: true,
      rejection_reasons: [],
      promotion_allowed: false,
      replacement_scope: 'cross_family',
      incumbent_family_id: 'VALUE_QUALITY',
    }),
  })
  assert(decision.decision_id === 'decision-v7-1', 'replacement projection must preserve immutable decision identity')
  assert(decision.status === 'proposed', 'replacement projection must preserve proposed verdicts')
  assert(decision.effective_paired_dates === 35.5, 'replacement projection must expose effective paired dates')
  assert(decision.paired_delta_hac_standard_error === 0.0011, 'replacement projection must expose paired HAC SE')
  assert(decision.paired_delta_lcb95_hac === 0.0022, 'replacement projection must expose paired HAC LCB95')
  assert(decision.paired_delta_one_sided_p_value === 0.012, 'replacement projection must expose one-sided p-value')
  assert(decision.paired_delta_power_at_minimum_economic_delta === 0.83, 'replacement projection must expose local-alpha power')
  assert(decision.candidate_absolute_effective_dates === 36.5, 'replacement projection must expose candidate absolute ESS')
  assert(decision.candidate_absolute_cost_net_lcb95_hac === 0.0031, 'replacement projection must expose candidate absolute HAC LCB95')
  assert(decision.holm_family_size === 8 && decision.holm_rank === 2, 'replacement projection must expose Holm family and rank')
  assert(decision.holm_local_alpha === 0.007142857142857143, 'Holm critical alpha must project under the local-alpha API name')
  assert(decision.holm_adjusted_p_value === 0.048 && decision.holm_rejected === true, 'replacement projection must expose Holm verdict evidence')

  const legacy = projectStrategyReplacementDecisionSummary({
    decision_id: 'decision-legacy',
    run_id: 'run-legacy',
    as_of_date: '2026-08-01',
    family_id: 'TREND_RECLAIM_CONTINUATION',
    candidate_strategy_id: 'candidate-legacy',
    candidate_strategy_version: 'v1',
    replaced_strategy_id: 'incumbent-legacy',
    replaced_strategy_version: 'v1',
    status: 'rejected',
    paired_dates: 12,
    paired_delta_mean: null,
    paired_delta_lcb90: null,
    candidate_absolute_mean: null,
    candidate_max_drawdown: null,
    replaced_max_drawdown: null,
    candidate_turnover: null,
    replaced_turnover: null,
    return_correlation: null,
    evidence_json: '{}',
  })
  assert(legacy.effective_paired_dates === null && legacy.holm_rejected === null, 'legacy evidence must remain readable with nullable V7 fields')
}

{
  const run = projectStrategyReplacementRunEvidence(JSON.stringify({
    production_owner_count_before: 8,
    production_owner_count_after: 8,
    serving_owner_coverage_complete: true,
    candidate_portfolio: {
      dates: 44,
      residual_mean: 0.003,
      residual_lcb90: 0.001,
      absolute_mean: 0.006,
      absolute_effective_dates: 37.5,
      absolute_hac_standard_error: 0.0012,
      absolute_lcb95_hac: 0.004,
    },
    champion_comparison: {
      champion_run_id: 'champion-v6',
      paired_dates: 44,
      hac_lag: 4,
      effective_paired_dates: 36.25,
      paired_residual_delta_mean: 0.003,
      paired_residual_delta_lcb90_iid_diagnostic_only: 0.0014,
      paired_residual_delta_hac_standard_error: 0.0011,
      paired_residual_delta_lcb95_hac: 0.0012,
      paired_residual_delta_one_sided_p_value: 0.02,
      power_at_minimum_economic_delta: 0.81,
      minimum_economic_delta: 0.001,
    },
    portfolio_risk: {
      baseline_max_drawdown: -0.06,
      final_max_drawdown: -0.05,
      baseline_turnover: 0.32,
      final_turnover: 0.29,
      return_correlation: 0.88,
      correlation_pass: true,
      turnover_pass: true,
    },
    promotion_gates: {
      statistical_policy_version: 'strategy-replacement-policy-v7-hac4-holm-power80-v1',
      holm_family_size: 8,
      full_portfolio_all_gates_pass: false,
      full_portfolio_rejection_reasons: ['no_holm_accepted_replacement'],
    },
  }))
  assert(run.production_owner_count_before === 8 && run.production_owner_count_after === 8, 'run projection must expose owner-count actuals')
  assert(run.candidate_portfolio.absolute_effective_dates === 37.5, 'run projection must expose final portfolio absolute ESS')
  assert(run.champion_comparison.paired_residual_delta_lcb95_hac === 0.0012, 'run projection must expose portfolio paired HAC LCB95')
  assert(run.portfolio_risk.final_turnover === 0.29, 'run projection must preserve portfolio risk actuals')
  assert(run.promotion_gates.holm_family_size === 8, 'run projection must not discard numeric gate actuals')
  assert(run.promotion_gates.statistical_policy_version === 'strategy-replacement-policy-v7-hac4-holm-power80-v1', 'run projection must not discard gate version evidence')
  assert(Array.isArray(run.promotion_gates.full_portfolio_rejection_reasons), 'run projection must not discard gate rejection reasons')
}


{
  assert(!shouldRetireStaleStrategyRewardRows({
    dryRun: false,
    hasStartDate: false,
    refreshRunId: 'refresh-empty',
    ledgerRows: 0,
    persistedRows: 0,
  }), 'empty reward refresh must never retire the previous ledger')
  assert(!shouldRetireStaleStrategyRewardRows({
    dryRun: false,
    hasStartDate: false,
    refreshRunId: 'refresh-partial',
    ledgerRows: 4,
    persistedRows: 3,
  }), 'partially persisted reward refresh must preserve the previous ledger')
  assert(shouldRetireStaleStrategyRewardRows({
    dryRun: false,
    hasStartDate: false,
    refreshRunId: 'refresh-complete',
    ledgerRows: 4,
    persistedRows: 4,
  }), 'complete full-window reward refresh may retire stale ledger rows')
}

class FakeStrategyRegistryStatement {
  constructor(
    private readonly db: FakeStrategyRegistryD1,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStrategyRegistryStatement {
    return new FakeStrategyRegistryStatement(this.db, this.sql, args)
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql
    if (sql.includes('INSERT INTO strategy_spec_registry')) {
      const row = this.db.rowFromInsertArgs(this.args)
      const key = `${row.strategy_id}:${row.version}`
      const existing = this.db.rows.get(key)
      if (existing) {
        row.status = existing.status
        row.owner_type = existing.owner_type
        row.promotion_status = existing.promotion_status
      }
      this.db.rows.set(key, row)
      return { meta: { changes: 1 } }
    }
    if (sql.includes('WHERE strategy_id=?')) {
      const [updatedAt, strategyId] = this.args
      let changes = 0
      for (const row of this.db.rows.values()) {
        if (row.strategy_id === strategyId && row.status !== 'retired') {
          row.status = 'retired'
          row.owner_type = 'retired'
          row.promotion_status = 'retired'
          row.updated_at = String(updatedAt)
          changes += 1
        }
      }
      return { meta: { changes } }
    }
    if (sql.includes('strategy_id NOT IN')) {
      const [updatedAt, ...approvedIds] = this.args.map(String)
      const approved = new Set(approvedIds)
      let changes = 0
      for (const row of this.db.rows.values()) {
        const sourceRefs = JSON.parse(row.source_refs_json || '[]') as string[]
        const generated =
          row.strategy_id.startsWith('finlab_ai_skill_')
          || row.created_by === 'finlab_ai_skill_discovery_v1'
          || sourceRefs.some((ref) => String(ref).includes('finlab_ai_skill'))
        if (row.status !== 'retired' && !approved.has(row.strategy_id) && generated) {
          row.status = 'retired'
          row.owner_type = 'retired'
          row.promotion_status = 'retired'
          row.updated_at = String(updatedAt)
          changes += 1
        }
      }
      return { meta: { changes } }
    }
    return { meta: { changes: 0 } }
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM strategy_spec_registry')) {
      return { results: [...this.db.rows.values()] as T[] }
    }
    return { results: [] }
  }
}

class FakeStrategyRegistryD1 {
  readonly rows = new Map<string, StrategySpecRegistryRow>()

  prepare(sql: string): FakeStrategyRegistryStatement {
    return new FakeStrategyRegistryStatement(this, sql)
  }

  rowFromInsertArgs(args: unknown[]): StrategySpecRegistryRow {
    const [
      strategy_id,
      version,
      name,
      status,
      owner,
      alpha_bucket,
      family_id,
      variant_id,
      owner_type,
      promotion_status,
      supported_regimes_json,
      thesis,
      thresholds_json,
      candidate_policy_json,
      risk_notes_json,
      source_refs_json,
      created_by,
      created_at,
      updated_at,
    ] = args
    return {
      strategy_id: String(strategy_id),
      version: String(version),
      name: String(name),
      status: status as StrategySpecRegistryRow['status'],
      owner: owner as StrategySpecRegistryRow['owner'],
      alpha_bucket: String(alpha_bucket),
      family_id: family_id as StrategySpecRegistryRow['family_id'],
      variant_id: String(variant_id),
      owner_type: owner_type as StrategySpecRegistryRow['owner_type'],
      promotion_status: promotion_status as StrategySpecRegistryRow['promotion_status'],
      supported_regimes_json: String(supported_regimes_json),
      thesis: String(thesis),
      thresholds_json: String(thresholds_json),
      candidate_policy_json: String(candidate_policy_json),
      risk_notes_json: String(risk_notes_json),
      source_refs_json: String(source_refs_json),
      created_by: String(created_by),
      created_at: String(created_at),
      updated_at: String(updated_at),
    }
  }
}

interface FakePriceRow {
  symbol: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

class FakeCandidateFeatureStatement {
  constructor(
    private readonly rows: FakePriceRow[],
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeCandidateFeatureStatement {
    return new FakeCandidateFeatureStatement(this.rows, args)
  }

  async all<T>(): Promise<{ results: T[] }> {
    const date = String(this.args[this.args.length - 1] ?? '')
    const symbols = new Set(this.args.slice(0, -1).map(String))
    const results = this.rows
      .filter((row) => symbols.has(row.symbol) && row.date <= date)
      .sort((left, right) => left.symbol.localeCompare(right.symbol) || right.date.localeCompare(left.date))
    return { results: results as T[] }
  }
}

class FakeCandidateFeatureD1 {
  constructor(private readonly rows: FakePriceRow[]) {}

  prepare(sql: string): FakeCandidateFeatureStatement {
    assert(sql.includes('stock_prices'), 'daily strategy candidate feature hydration should read stock_prices')
    assert(sql.includes('ROW_NUMBER() OVER (PARTITION BY s.symbol ORDER BY sp.date DESC)'), 'daily hydration must cap bars per symbol, not with one global LIMIT')
    assert(sql.includes('price_rank <= 70'), 'daily hydration must keep the latest 70 bars for every requested symbol')
    assert(!sql.includes('LIMIT ?'), 'daily hydration must not truncate later symbols with a global LIMIT')
    return new FakeCandidateFeatureStatement(this.rows)
  }
}

{
  const source = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
  assert(
    source.includes('INSERT INTO strategy_decision_log') &&
      source.includes('ON CONFLICT(date, symbol, strategy_id, strategy_version) DO UPDATE SET') &&
      !source.includes('INSERT OR REPLACE INTO strategy_decision_log'),
    'strategy decision materialization must use in-place UPSERT without REPLACE delete/insert write amplification',
  )
  assert(source.includes('STRATEGY_LEARNING_D1_BATCH_SIZE'), 'strategy learning replay writes must be chunked for D1 production latency')
  assert(source.includes('STRATEGY_LEARNING_DEFAULT_CANDIDATE_LIMIT = 2000'), 'strategy learning must default to full L0 universe scale, not the old 500-candidate partial cap')
  assert(source.includes('STRATEGY_LEARNING_D1_BATCH_SIZE = 250'), 'strategy learning D1 writes must avoid excessive 50-row round trips that can be killed in callback waitUntil')
  assert(source.includes('await db.batch(chunk)'), 'strategy learning replay must use D1 batch persistence')
  assert(
    source.includes("canonicalStrategyLifecycleStatus(spec.status) === 'candidate'")
      && source.includes('loadStrategyReplacementGateSummary(db, date, candidateStrategyKeys)'),
    'Atomic V7 prefilter loader must receive canonical Candidate keys from the registry projection',
  )
  assert(
    source.includes('FROM strategy_marginal_edge_v4 edge')
      && source.includes('FROM json_each(?) candidate_key')
      && source.includes("candidate_key.value = edge.strategy_id || '|' || edge.strategy_version"),
    'Atomic V7 prefilter query must exclude Active rows before API projection',
  )
  assert(
    source.includes('candidate_prefilters: projectStrategyReplacementCandidatePrefilters([], candidateStrategyKeys)'),
    'missing or unavailable Atomic V7 runs must retain complete Candidate keys with explicit missing evidence',
  )
  assert(
    !source.includes("status: 'not_applicable' | 'pending'")
      && !source.includes("activationDecision?.status ?? 'pending'")
      && source.includes("'evidence_pending' | 'prefilter_failed' | 'not_evaluated'"),
    'Candidate activation must not collapse no-run, prefilter-failed, or no-pair states into generic pending',
  )
  assert(
    source.includes('atomic_replacement_v7_evidence_pending')
      && source.includes('atomic_replacement_v7_prefilter_failed')
      && source.includes('atomic_replacement_v7_no_pair'),
    'Candidate missing-evidence reasons must distinguish evidence, prefilter, and pair blockers',
  )
  assert(
    source.includes('selection_reference_snapshots_v1') &&
      source.includes('r.hard_gate_passed=1') &&
      source.includes('r.symbol>?') &&
    source.includes('screener_funnel_items') &&
      source.includes('raw_signals') &&
      source.includes('funnel_candidates') &&
      source.includes('fc.evidence AS funnel_evidence') &&
      source.includes('canonical_run_heads'),
    'strategy learning must keyset-page the complete canonical L0 reference universe and only use funnel rows for evidence hydration',
  )
  assert(
    source.includes('writeEvidenceArtifact') &&
      source.includes('strategy_candidate_contexts') &&
      source.includes('strategy-evidence-pointer-v1'),
    'strategy decision evidence must be R2-first with one normalized date/symbol D1 context and pointer-only repeated strategy rows',
  )
  assert(
    source.includes('retireGeneratedDiscoveryStrategySpecs') &&
      source.includes("SET status='retired'") &&
      source.includes("strategy_id NOT IN (${placeholders})") &&
      source.includes("source_refs_json LIKE '%finlab_ai_skill%'") &&
      source.includes('demoted_stale_active'),
    'strategy registry seeding must retire stale generated FinLab AI discovery rows that are not source-approved production specs',
  )
  assert(
    !source.includes('default_fallback') &&
      !source.includes('DEFAULT_STRATEGY_SPECS.filter((spec) => !registryKeys.has') &&
      source.includes('strategy_spec_registry_empty_seed_required') &&
      source.includes('strategy_spec_registry_no_runtime_specs_seed_required') &&
      source.includes('strategy_spec_registry_contains_stale_generated_rows_seed_required') &&
      source.includes('strategy_spec_registry_contains_stale_runtime_rows_seed_required') &&
      source.includes('candidate_policy_json'),
    'runtime strategy specs must come from D1 registry only; code defaults are seed manifests, not silent screener fallback',
  )
  assert(
    source.includes('hydrateStrategyCandidateDailyFeatures') &&
      source.includes('materializeFormal137FeatureAliases(candidates.map') &&
      source.includes('materializeSmrcVwapCrossSectionalRanks(candidates)') &&
      source.includes('ROW_NUMBER() OVER (PARTITION BY s.symbol ORDER BY sp.date DESC)') &&
      source.includes('price_rank <= 70') &&
      !source.includes('Math.min(5000, symbolsNeedingOhlcv.length * 70)') &&
      source.includes('JOIN stocks s ON s.id = sp.stock_id'),
    'strategy learning candidates must materialize daily VWAP/SMC aliases before strategy decision evaluation',
  )
}

{
  const activeSpecs = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'active')
  const candidateSpecs = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'candidate')
  assert(activeSpecs.length === 7, 'bootstrap strategy manifest should expose the five retained owners plus 0081 and FinLab reversion')
  assert(candidateSpecs.length === 2, 'bootstrap strategy manifest should keep only unpromoted FinLab owners in candidate pool')
  assert(activeSpecs.filter((spec) => spec.id.startsWith('research_consolidated_')).length === 0, 'research consolidated strategies must not remain in bootstrap runtime defaults')
  assert(activeSpecs.filter((spec) => spec.id.startsWith('alphabuilders_multifactor_')).length === 1, 'bootstrap should keep only the retained AlphaBuilders production label')
  assert(activeSpecs.some((spec) => spec.id === 'alpha_miner_pymoo_nsga3_novelty_0081'), 'source-approved Pymoo 0081 must survive bootstrap seeding')
  assert(activeSpecs.some((spec) => spec.id === 'trend_following_seed_v1'), 'existing active strategies must stay active')
  assert(!activeSpecs.some((spec) => spec.id === 'finlab_ai_skill_discovery_v1'), 'daily factor/strategy discovery lane must not remain active')
}

async function runStrategyRegistrySeedContractTest(): Promise<void> {
  const fakeDb = new FakeStrategyRegistryD1()
  fakeDb.rows.set('finlab_ai_skill_generated_duplicate_v1:strategy-spec-v1', {
    strategy_id: 'finlab_ai_skill_generated_duplicate_v1',
    version: 'strategy-spec-v1',
    name: 'Generated duplicate',
    status: 'research',
    owner: 'strategy',
    alpha_bucket: 'trend_following',
    family_id: 'TREND_RECLAIM_CONTINUATION',
    variant_id: 'finlab_ai_skill_generated_duplicate_v1',
    owner_type: 'strategy',
    promotion_status: 'production',
    supported_regimes_json: '["bull"]',
    thesis: 'Stale generated discovery row should not remain a runtime strategy.',
    thresholds_json: '{}',
    candidate_policy_json: '{}',
    risk_notes_json: '[]',
    source_refs_json: '["finlab_ai_skill_discovery_v1"]',
    created_by: 'finlab_ai_skill_discovery_v1',
    created_at: '2026-06-03T00:00:00.000Z',
    updated_at: '2026-06-03T00:00:00.000Z',
  })

  let staleGuardTriggered = false
  try {
    await listStrategySpecsForLearning(fakeDb as unknown as D1Database)
  } catch (error) {
    staleGuardTriggered = String(error).includes('strategy_spec_registry_contains_stale_generated_rows_seed_required')
  }
  assert(staleGuardTriggered, 'runtime reader must fail closed when stale generated discovery rows remain in D1')

  const seedReport = await seedDefaultStrategySpecRegistry(fakeDb as unknown as D1Database, {
    nowIso: '2026-06-16T00:00:00.000Z',
  })
  const expectedActiveCount = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'active').length
  const expectedCandidateCount = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'candidate').length
  const { specs, registryRowCount, activeCount } = await listStrategySpecsForLearning(fakeDb as unknown as D1Database)
  assert(seedReport.seeded === DEFAULT_STRATEGY_SPECS.length, 'seed should write the full source-approved registry manifest')
  assert(seedReport.demoted_stale_active === 1, 'seed should retire stale generated discovery rows outside the approved runtime set')
  assert(registryRowCount === DEFAULT_STRATEGY_SPECS.length + 1, 'registry should preserve retired history while exposing clean runtime specs')
  assert(specs.length === DEFAULT_STRATEGY_SPECS.length, 'runtime reader should expose the bootstrap manifest after clean seed when no mined D1 strategies are present')
  assert(activeCount === expectedActiveCount, 'runtime reader active count should equal active bootstrap manifest size after clean seed')
  assert(specs.filter((spec) => spec.status === 'candidate').length === expectedCandidateCount, 'runtime reader should preserve candidate bootstrap specs after clean seed')
  assert(specs.every((spec) => spec.candidatePolicy && Object.keys(spec.candidatePolicy).length > 0), 'every runtime strategy must carry candidate policy from D1')
  assert(!specs.some((spec) => spec.id === 'finlab_ai_skill_discovery_v1'), 'retired discovery lane must not be visible to runtime reader')

  const preserveDb = new FakeStrategyRegistryD1()
  const retiredSpec = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'trend_following_seed_v1')
  assert(retiredSpec, 'test fixture must include trend_following_seed_v1')
  const retiredRow = strategySpecToRegistryRow(retiredSpec, '2026-06-16T00:00:00.000Z')
  retiredRow.status = 'retired'
  retiredRow.owner_type = 'retired'
  retiredRow.promotion_status = 'retired'
  preserveDb.rows.set(`${retiredRow.strategy_id}:${retiredRow.version}`, retiredRow)
  await seedDefaultStrategySpecRegistry(preserveDb as unknown as D1Database, {
    nowIso: '2026-06-16T00:01:00.000Z',
  })
  const preserved = preserveDb.rows.get(`${retiredRow.strategy_id}:${retiredRow.version}`)
  assert(preserved?.status === 'retired', 'registry seed must not resurrect D1-retired production strategies')
  assert(preserved?.owner_type === 'retired', 'registry seed must preserve retired owner_type')
  assert(preserved?.promotion_status === 'retired', 'registry seed must preserve retired promotion status')
}

runStrategyRegistrySeedContractTest().catch((error) => {
  throw error
})

async function runStrategyCandidateDailyFeatureHydrationTest(): Promise<void> {
  const priceRows: FakePriceRow[] = [
    { symbol: '1111', date: '2026-07-03', open: 10, high: 10.2, low: 9.9, close: 10.1, volume: 1000 },
    { symbol: '1111', date: '2026-07-04', open: 10.1, high: 10.5, low: 10, close: 10.4, volume: 1100 },
    { symbol: '1111', date: '2026-07-05', open: 10.4, high: 10.9, low: 10.3, close: 10.8, volume: 1300 },
    { symbol: '1111', date: '2026-07-06', open: 10.8, high: 11.4, low: 10.7, close: 11.3, volume: 1500 },
    { symbol: '1111', date: '2026-07-07', open: 11.3, high: 12, low: 11.2, close: 12, volume: 2000 },
    { symbol: '2222', date: '2026-07-03', open: 20, high: 20.3, low: 19.9, close: 20.1, volume: 1000 },
    { symbol: '2222', date: '2026-07-04', open: 20.1, high: 20.2, low: 19.6, close: 19.8, volume: 1100 },
    { symbol: '2222', date: '2026-07-05', open: 19.8, high: 20, low: 19.3, close: 19.5, volume: 1200 },
    { symbol: '2222', date: '2026-07-06', open: 19.5, high: 19.7, low: 19, close: 19.2, volume: 1300 },
    { symbol: '2222', date: '2026-07-07', open: 19.2, high: 19.4, low: 18.8, close: 19, volume: 1400 },
    { symbol: '3333', date: '2026-07-03', open: 30, high: 30.2, low: 29.8, close: 30, volume: 1000 },
    { symbol: '3333', date: '2026-07-04', open: 30, high: 30.2, low: 29.8, close: 30, volume: 1000 },
    { symbol: '3333', date: '2026-07-05', open: 30, high: 30.2, low: 29.8, close: 30, volume: 1000 },
    { symbol: '3333', date: '2026-07-06', open: 30, high: 30.2, low: 29.8, close: 30, volume: 1000 },
    { symbol: '3333', date: '2026-07-07', open: 30, high: 30.2, low: 29.8, close: 30, volume: 1000 },
  ]
  const candidates = [
    {
      symbol: '1111',
      current_price: 12,
      raw_signals: {
        close: 12,
        volumeExpansion20: 1.4,
        technicalIndicators: {
          smcNetScore: 0.2,
          smcBullishScore: 0.4,
          smcBiasBearish: 0,
          bestOrderBlockStrength: 0.7,
        },
      },
    },
    {
      symbol: '2222',
      current_price: 19,
      raw_signals: {
        close: 19,
        volumeExpansion20: 0.8,
        technicalIndicators: {
          smcNetScore: 0.1,
          smcBullishScore: 0.2,
          smcBiasBearish: 0,
          bestOrderBlockStrength: 0.3,
        },
      },
    },
    {
      symbol: '3333',
      current_price: 30,
      raw_signals: {
        close: 30,
        volumeExpansion20: 1,
      },
    },
  ]
  const telemetry = await hydrateStrategyCandidateDailyFeatures(
    new FakeCandidateFeatureD1(priceRows) as unknown as D1Database,
    '2026-07-07',
    candidates,
  )
  const strong = candidates[0].raw_signals as any
  const weak = candidates[1].raw_signals as any
  const noOrderBlock = candidates[2].raw_signals as any
  assert(telemetry.hydratedSymbols === 3, 'daily feature hydration should touch every candidate missing VWAP evidence')
  assert(strong.factorSignals.vwap_bias > 0, 'daily feature hydration should materialize positive same-day VWAP bias')
  assert(strong.factorSignals.vwap_bias_5d > 0, 'daily feature hydration should materialize positive 5-day VWAP bias')
  assert(weak.factorSignals.vwap_bias < 0, 'daily feature hydration should preserve weak VWAP evidence for ranking')
  assert(strong.factorSignals.finlabCsVwapBiasRank === 1, 'cross-sectional VWAP rank should favor the stronger reclaim setup')
  assert(strong.factorSignals.finlabCsVwapBias5dRank === 1, 'cross-sectional 5-day VWAP rank should favor the stronger reclaim setup')
  assert(strong.factorSignals.finlabCsBestOrderBlockStrengthRank === 1, 'cross-sectional order-block rank should use SMC strength evidence')
  assert(strong.factorSignals.finlabCsVolumeExpansion20Rank === 1, 'cross-sectional volume rank should use daily raw signals')
  assert(noOrderBlock.technicalIndicators.priceActionStructureAvailable === 1, 'valid daily bars must mark the price-action structure evaluable')
  assert(noOrderBlock.technicalIndicators.orderBlockDetected === 0, 'flat valid bars should record a real no-order-block observation')
  assert(noOrderBlock.technicalIndicators.bestOrderBlockStrength === 0, 'no detected order block must be zero strength rather than unavailable')

  const splitIdentityDb = {
    prepare(sql: string) {
      assert(sql.includes('FROM stocks'), 'cross-domain hydration must resolve symbol identity from Core')
      return {
        bind() { return this },
        async all() { return { results: [{ id: 3, symbol: '3333' }] } },
      }
    },
  } as unknown as D1Database
  const splitMarketRows = priceRows
    .filter((row) => row.symbol === '3333')
    .map((row) => ({ ...row, stock_id: 3 }))
  const splitMarketDb = {
    prepare(sql: string) {
      assert(sql.includes('FROM stock_prices'), 'cross-domain hydration must read OHLCV from Market')
      assert(sql.includes('PARTITION BY stock_id'), 'cross-domain hydration must rank Market rows by stock identity')
      assert(!sql.includes('JOIN stocks'), 'cross-domain hydration must not issue a cross-D1 join')
      return {
        bind() { return this },
        async all() { return { results: splitMarketRows } },
      }
    },
  } as unknown as D1Database
  const splitCandidates = [{ symbol: '3333', current_price: 30, raw_signals: { close: 30 } }]
  const splitTelemetry = await hydrateStrategyCandidateDailyFeatures(
    splitMarketDb,
    '2026-07-07',
    splitCandidates,
    splitIdentityDb,
  )
  assert(splitTelemetry.hydratedSymbols === 1, 'Core identity plus Market OHLCV must hydrate the split-D1 candidate')
}

runStrategyCandidateDailyFeatureHydrationTest().catch((error) => {
  throw error
})

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'shadow' as const }
  const row = strategySpecToRegistryRow(spec, '2026-05-19T00:00:00.000Z')
  const restored = registryRowToStrategySpec(row)
  assert(restored.id === spec.id, 'registry conversion should preserve strategy id')
  assert(restored.name === spec.name, 'registry conversion should preserve strategy display name')
  assert(restored.status === 'candidate', 'registry conversion should canonicalize legacy shadow status to Candidate')
  assert(restored.candidatePolicy?.poolQuota === spec.candidatePolicy?.poolQuota, 'registry conversion should restore candidate-pool policy for default specs')
}

{
  const spec = DEFAULT_STRATEGY_SPECS.find((row) => row.id === 'alphabuilders_multifactor_revenue_quality_momentum_v1')
  assert(spec != null, 'retained AlphaBuilders revenue quality momentum default spec should exist')
  const registryRow = strategySpecToRegistryRow(spec!, '2026-06-03T00:00:00.000Z')
  const restored = registryRowToStrategySpec(registryRow)
  assert(
    restored.familyId === 'REVENUE_QUALITY_MOMENTUM',
    'registry conversion must preserve default family governance for retained AlphaBuilders strategy',
  )
  assert(restored.ownerType === 'strategy', 'registry conversion must preserve production ownerType for default active specs')
  assert(restored.variantId === spec!.variantId, 'registry conversion must preserve variantId for default active specs')
}

{
  const staleLegacyRow = strategySpecToRegistryRow({
    ...DEFAULT_STRATEGY_SPECS[0],
    status: 'shadow' as const,
    thresholds: { minSeedScore: 58, minTechScore: 18, minMomentumScore: 6, minPrice: 10 },
  }, '2026-05-21T00:00:00.000Z', {
    sourceRefs: ['codex_seed_2026_05_22'],
  })
  const restored = registryRowToStrategySpec(staleLegacyRow)
  assert(restored.status === 'candidate', 'registry conversion must canonicalize legacy D1 shadow status to Candidate')
  assert(restored.thresholds.minSeedScore === 58, 'registry conversion must expose stale Score V2 thresholds so runtime seed guard can fail closed')
  assert(restored.candidatePolicy?.poolQuota === DEFAULT_STRATEGY_SPECS[0].candidatePolicy?.poolQuota, 'registry conversion should preserve candidate policy stored in D1 row')
}

{
  const rows = buildStrategyDecisionRows(
    '2026-05-19',
    [
      {
        symbol: '2330',
        name: 'TSMC',
        current_price: 900,
        raw_signals: {
          closeAboveMa20Pct: 0.03,
          closeAboveMa60Pct: 0.02,
          volumeExpansion20: 1.25,
          return20d: 0.06,
          foreignTrustNet5d: 1000,
          brokerCount: 8,
          revenueGrowthYoY: 8,
          roe: 12,
        },
      },
    ],
    DEFAULT_STRATEGY_SPECS,
    { nowIso: '2026-05-19T00:00:00.000Z' },
  )
  assert(rows.length === DEFAULT_STRATEGY_SPECS.length, 'decision log should evaluate every strategy spec')
  assert(rows.some((row) => row.matched === 1), 'strong candidate should match at least one strategy')
  assert(rows.every((row) => row.decision_id.includes('2026-05-19-2330')), 'decision id should include date and symbol')
{
  const date = '2026-08-15'
  const revenueSpec = DEFAULT_STRATEGY_SPECS.find((row) => row.id === 'finlab_ai_skill_revenue_revision_breakout_v1')!
  const evidence = resolveLegacyMonthlyRevenueEvidence({
    signalDate: date,
    observedTaipeiDate: date,
    evidenceMode: 'live_current',
  }).evidence
  const candidate = {
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      monthlyRevenueEvidence: evidence,
      closeAboveMa20Pct: 0.025,
      volumeExpansion20: 1.18,
      return20d: 0.04,
      revenueGrowthYoY: 9,
      monthlyRevenueYoY: 14,
      monthlyRevenueMoM: 2,
      roe: 13,
      eps: 1.6,
      technicalIndicators: {
        rsi14: 56,
        volumeExpansion20: 1.18,
        closeAboveMa20Pct: 0.025,
      },
      factorSignals: {
        monthlyRevenueYoY: 14,
        monthlyRevenueMoM: 2,
        revenueGrowthYoY: 9,
      },
    },
  }
  const [historical] = buildStrategyDecisionRows(
    date,
    [candidate],
    [revenueSpec],
    { nowIso: `${date}T00:00:00.000Z` },
  )
  assert(historical.evaluable === 0, 'stored LIVE metadata must not self-authorize historical learning')
  assert(
    historical.unavailable_reason?.includes(MONTHLY_REVENUE_PIT_UNAVAILABLE_REASON) === true,
    'historical learning must retain the exact monthly revenue PIT blocker',
  )
  const [live] = buildStrategyDecisionRows(
    date,
    [candidate],
    [revenueSpec],
    { nowIso: `${date}T00:00:00.000Z`, evidenceMode: 'live_current' },
  )
  assert(live.evaluable === 1 && live.matched === 1, 'only caller-authorized same-day live evidence may produce a positive revenue decision')
}

}

{
  const rows = buildStrategyDecisionRows(
    '2026-05-19',
    [
      {
        symbol: '2330',
        name: 'TSMC',
        current_price: 900,
        raw_signals: {
          closeAboveMa20Pct: 0.03,
          closeAboveMa60Pct: 0.02,
          volumeExpansion20: 1.25,
          return20d: 0.06,
          foreignTrustNet5d: 1000,
          brokerCount: 8,
          revenueGrowthYoY: 8,
          roe: 12,
        },
      },
    ],
    DEFAULT_STRATEGY_SPECS,
    { nowIso: '2026-05-19T00:00:00.000Z' },
  )
  const matched = rows.find((row) => row.matched === 1)
  assert(matched != null, 'strategy learning should match by raw strategy signals')
  const context = JSON.parse(matched.context_json)
  assert(context.candidate.raw_signals.volumeExpansion20 === 1.25, 'decision context should persist raw volume evidence')
  assert(context.candidate.raw_signals.closeAboveMa20Pct === 0.03, 'decision context should persist raw price structure evidence')
  assert(!('score_v2' in context.candidate), 'decision context must not use Score V2 as L1 strategy evidence')
  assert(!('chip_score' in context.candidate), 'decision context must not persist legacy chip_score')
  assert(!('tech_score' in context.candidate), 'decision context must not persist legacy tech_score')
  assert(!('momentum_score' in context.candidate), 'decision context must not persist legacy momentum_score')
}

{
  const ledger = buildStrategyRewardLedgerRows([
    {
      date: '2026-05-15',
      symbol: '2330',
      strategy_id: 'trend_following_seed_v1',
      strategy_version: 'strategy-spec-v1',
      strategy_status: 'shadow',
      alpha_bucket: 'trend_following',
      market_segment: 'LISTED',
      absolute_return_net: 0.02,
      residual_return_net: 0.02,
    },
    {
      date: '2026-05-16',
      symbol: '2317',
      strategy_id: 'trend_following_seed_v1',
      strategy_version: 'strategy-spec-v1',
      strategy_status: 'shadow',
      alpha_bucket: 'trend_following',
      market_segment: 'LISTED',
      absolute_return_net: -0.01,
      residual_return_net: -0.01,
    },
  ], { nowIso: '2026-05-19T00:00:00.000Z' })
  assert(ledger.length === 1, 'ledger should aggregate rows by strategy/version/segment/regime')
  assert(ledger[0].samples === 2, 'ledger should count reward samples')
  assert(ledger[0].hit_rate === 0.5, 'ledger should compute hit rate')
  assert(ledger[0].avg_return_pct === 0.005, 'ledger should compute average return')
  assert(ledger[0].max_drawdown_pct === -0.01, 'ledger MDD should compound one equal-weight portfolio return per date')
  const evidence = JSON.parse(ledger[0].evidence_json)
  assert(
    evidence.max_drawdown_semantic === 'date_clustered_equal_weight_compounded_residual_return_v1',
    'ledger evidence should expose the date-clustered compounded MDD semantic',
  )
}

{
  const ledger = buildStrategyRewardLedgerRows([
    {
      date: '2026-05-15', symbol: '2330', strategy_id: 'same_day_portfolio', strategy_version: 'v1',
      strategy_status: 'shadow', alpha_bucket: 'trend_following', market_segment: 'LISTED',
      absolute_return_net: -0.2, residual_return_net: -0.2,
    },
    {
      date: '2026-05-15', symbol: '2317', strategy_id: 'same_day_portfolio', strategy_version: 'v1',
      strategy_status: 'shadow', alpha_bucket: 'trend_following', market_segment: 'LISTED',
      absolute_return_net: 0.2, residual_return_net: 0.2,
    },
    {
      date: '2026-05-16', symbol: '2454', strategy_id: 'same_day_portfolio', strategy_version: 'v1',
      strategy_status: 'shadow', alpha_bucket: 'trend_following', market_segment: 'LISTED',
      absolute_return_net: -0.1, residual_return_net: -0.1,
    },
  ])
  assert(ledger[0].max_drawdown_pct === -0.1, 'same-day symbols must be equal-weighted before chronological drawdown')
}

{
  const daily = buildStrategyRewardDailyStatsRows([
    {
      date: '2026-05-15', symbol: '2330', strategy_id: 'daily_projection', strategy_version: 'v1',
      strategy_status: 'shadow', alpha_bucket: 'mean_reversion', residual_return_net: 0.03,
    },
    {
      date: '2026-05-15', symbol: '2317', strategy_id: 'daily_projection', strategy_version: 'v1',
      strategy_status: 'shadow', alpha_bucket: 'mean_reversion', residual_return_net: -0.01,
    },
    {
      date: '2026-05-16', symbol: '2454', strategy_id: 'daily_projection', strategy_version: 'v1',
      strategy_status: 'shadow', alpha_bucket: 'mean_reversion', residual_return_net: 0.02,
    },
  ], { nowIso: '2026-05-20T00:00:00.000Z', refreshRunId: 'refresh-v1' })
  assert(daily.length === 2, 'daily projection must retain one row per signal date and strategy version')
  assert(daily[0].reward_samples === 2 && daily[0].reward_hits === 1, 'daily projection must retain sample and hit counts')
  assert(daily[0].date_portfolio_return === 0.01, 'daily projection must equal-weight same-date rewards')
  assert(daily[0].reward_refresh_run_id === 'refresh-v1', 'daily projection must retain refresh lineage')

  const stable = summarizeDateClusteredReturns(Array.from({ length: 12 }, (_, index) => 0.01 + index * 0.0001))
  assert(stable.mean != null && stable.mean > 0, 'date-clustered mean should retain positive edge')
  assert(stable.lcb90 != null && stable.lcb90 > 0, 'stable cross-date edge should have a positive one-sided LCB')
  assert(summarizeDateClusteredReturns([0.01]).lcb90 == null, 'one date must not manufacture confidence')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'shadow' as const }
  const summary = {
    version: 'strategy-learning-v5',
    date: '2026-07-28',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: strategyLearningEvidence({
        decisions: 16042,
        matched: 1937,
        match_rate: 0.120746,
        today_decisions: 0,
        today_evaluable_decisions: 0,
        today_unavailable_decisions: 0,
        rolling_decisions: 0,
        rolling_evaluable_decisions: 0,
        rolling_unavailable_decisions: 0,
        rolling_matched: 0,
        rolling_match_rate: null,
        rolling_sessions: 0,
        rolling_samples: 0,
        rolling_hit_rate: null,
        rolling_avg_return_pct: null,
        rolling_max_drawdown_pct: null,
        rolling_reward_dates: 0,
        rolling_date_return_mean: null,
        rolling_date_return_lcb90: null,
      }),
    }],
    promotion_gate: [],
    replacement_gate: strategyReplacementGateEvidence(),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].evidence.lifetime_decisions === 16042, 'gate evidence must expose cumulative observability')
  assert(gate[0].evidence.decisions === 0, 'promotion must use rolling decisions rather than lifetime totals')
  assert(gate[0].missing_evidence.includes('mature_dates_lt_10'), 'promotion must require independent mature dates')
  assert(!gate[0].missing_evidence.includes('date_return_lcb90_not_positive'), 'single-strategy LCB90 must remain diagnostic rather than a universal promotion gate')
  assert(gate[0].diagnostic_only_metrics.includes('date_return_lcb90'), 'gate contract must expose LCB90 as diagnostic-only')
  const policy = buildStrategyAdaptivePolicyState({ ...summary, promotion_gate: gate })
  assert(gate[0].strategy_status === 'candidate', 'legacy shadow rows must normalize to Candidate at the learning boundary')
  assert(policy.strategy_weights[spec.id] === 0, 'Candidate evidence must stay observable but receive zero production weight')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'shadow' as const }
  const summary = {
    version: 'strategy-learning-v5',
    date: '2026-05-19',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: strategyLearningEvidence(),

    }],
    promotion_gate: [],
    replacement_gate: strategyReplacementGateEvidence(),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'not_ready', 'mature Candidate evidence must still wait for Atomic V7 acceptance')
  assert(gate[0].requires_wei_approval === false, 'strategy promotion is automatic but remains Edge V5 gated')
  assert(gate[0].current_stage === 'candidate_evidence', 'legacy shadow status must surface as Candidate evidence')
  assert(gate[0].recommended_stage === 'candidate_evidence', 'Candidate must stay Candidate until Atomic V7 accepts a replacement')
  assert(gate[0].l3_requires_wei_approval === false, 'Candidate evidence does not equal production allocation')
  assert(gate[0].production_effect === false, 'strategy gate must not mutate production')

  const policy = buildStrategyAdaptivePolicyState({ ...summary, promotion_gate: gate })
  assert(policy.status === 'active', 'Adaptive policy is the sole active threshold and weight owner')
  assert(policy.evidence.production_effect === true, 'PIT policy must explicitly declare its production effect')
  assert(policy.evidence.requires_approval_to_activate === false, 'daily policy refresh must not depend on a manual activation toggle')
  assert(policy.strategy_weights[spec.id] === 0, 'Candidate strategy must remain full-universe observable without production weight')
  assert(policy.lifecycle_recommendations[spec.id].recommended_status === 'candidate', 'Candidate must remain Candidate without Atomic V7 acceptance')
  assert(policy.evidence.threshold_owner === 'versioned_strategy_spec', 'versioned specs must remain the only production threshold owner')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'shadow' as const }
  const summary = {
    version: 'strategy-learning-v1',
    date: '2026-05-19',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: strategyLearningEvidence({
        decisions: 3,
        matched: 1,
        match_rate: 0.333333,
        rolling_decisions: 3,
        rolling_matched: 1,
        rolling_match_rate: 0.333333,
        rolling_sessions: 1,
        samples: 2,
        hit_rate: 0.5,
        avg_return_pct: -0.01,
        max_drawdown_pct: -0.12,
        rolling_samples: 2,
        rolling_hit_rate: 0.5,
        rolling_avg_return_pct: -0.01,
        rolling_max_drawdown_pct: -0.12,
        rolling_reward_dates: 1,
        rolling_date_return_mean: -0.01,
        rolling_date_return_lcb90: null,
      }),
    }],
    promotion_gate: [],
    replacement_gate: strategyReplacementGateEvidence(),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'not_ready', 'weak evidence should not be ready for strategy promotion')
  assert(gate[0].recommended_stage === 'candidate_evidence', 'weak Candidate evidence should stay Candidate')
  assert(gate[0].missing_evidence.includes('samples_lt_30'), 'gate should expose sample shortage')
  assert(!gate[0].missing_evidence.includes('avg_return_not_positive'), 'absolute average return must remain diagnostic rather than a universal hard gate')
  assert(gate[0].activation_gate.status === 'evidence_pending', 'Candidate without a ready replacement run must expose evidence_pending')
  assert(gate[0].missing_evidence.includes('atomic_replacement_v7_evidence_pending'), 'Candidate without a ready replacement run must expose the evidence blocker')
  assert(!gate[0].missing_evidence.includes('atomic_replacement_v7_not_accepted'), 'no-run Candidate must not be mislabeled as a rejected decision')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'candidate' as const }
  const summary = {
    version: 'strategy-learning-v5',
    date: '2026-08-28',
    spec_source: 'registry',
    specs: [{ ...spec, learning: strategyLearningEvidence() }],
    promotion_gate: [],
    replacement_gate: candidatePrefilterGate(spec.id, spec.version, false),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].activation_gate.status === 'prefilter_failed', 'ineligible ready Candidate prefilter must expose prefilter_failed')
  assert(gate[0].missing_evidence.includes('atomic_replacement_v7_prefilter_failed'), 'prefilter failure must expose its own blocker reason')
  assert(!gate[0].missing_evidence.includes('atomic_replacement_v7_not_accepted'), 'prefilter failure must not masquerade as a replacement rejection')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'candidate' as const }
  const summary = {
    version: 'strategy-learning-v5',
    date: '2026-08-28',
    spec_source: 'registry',
    specs: [{ ...spec, learning: strategyLearningEvidence() }],
    promotion_gate: [],
    replacement_gate: candidatePrefilterGate(spec.id, spec.version, true),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].activation_gate.status === 'not_evaluated', 'eligible Candidate without a pair must expose not_evaluated')
  assert(gate[0].missing_evidence.includes('atomic_replacement_v7_no_pair'), 'eligible Candidate without a pair must expose the no-pair blocker')
  assert(!gate[0].missing_evidence.includes('atomic_replacement_v7_not_accepted'), 'no-pair Candidate must not masquerade as a replacement rejection')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'candidate' as const }
  const summary = {
    version: 'strategy-learning-v1',
    date: '2026-05-19',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: strategyLearningEvidence(),

    }],
    promotion_gate: [],
    replacement_gate: acceptedStrategyReplacementGate(spec.id, spec.version),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].recommended_stage === 'active', 'Atomic V7 accepted Candidate should request Active lifecycle status')
  assert(gate[0].activation_gate.status === 'accepted', 'candidate activation must expose accepted Atomic V7 evidence')
  assert(gate[0].l3_requires_wei_approval === false, 'L3 production allocation must be automatically governed by Edge V5')
  assert(gate[0].production_effect === false, 'L3 gate is still metadata until approved')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'candidate' as const }
  const replacementGate = acceptedStrategyReplacementGate(spec.id, spec.version)
  replacementGate.decisions[0] = {
    ...replacementGate.decisions[0],
    status: 'proposed',
    promotion_allowed: false,
  }
  const summary = {
    version: 'strategy-learning-v5',
    date: '2026-08-28',
    spec_source: 'registry',
    specs: [{ ...spec, learning: strategyLearningEvidence() }],
    promotion_gate: [],
    replacement_gate: replacementGate,
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'not_ready', 'proposed replacement must not activate a Candidate before cutover')
  assert(gate[0].activation_gate.status === 'proposed', 'activation summary must preserve proposed verdicts')
  assert(gate[0].activation_gate.decision_id === replacementGate.decisions[0].decision_id, 'activation summary must retain proposed decision identity')
  assert(gate[0].missing_evidence.includes('atomic_replacement_v7_not_accepted'), 'proposed replacement may retain the not-accepted blocker')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'candidate' as const }
  const replacementGate = acceptedStrategyReplacementGate(spec.id, spec.version)
  replacementGate.decisions[0] = {
    ...replacementGate.decisions[0],
    status: 'rejected',
    promotion_allowed: true,
    rejection_reasons: ['paired_delta_lcb95_hac_not_positive'],
  }
  const summary = {
    version: 'strategy-learning-v5',
    date: '2026-08-28',
    spec_source: 'registry',
    specs: [{ ...spec, learning: strategyLearningEvidence() }],
    promotion_gate: [],
    replacement_gate: replacementGate,
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'not_ready', 'rejected replacement must not activate a Candidate')
  assert(gate[0].activation_gate.status === 'rejected', 'activation summary must preserve rejected verdicts')
  assert(gate[0].activation_gate.run_id === replacementGate.decisions[0].run_id, 'activation summary must retain rejected run identity')
  assert(gate[0].missing_evidence.includes('atomic_replacement_v7_not_accepted'), 'rejected replacement may retain the not-accepted blocker')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'active' as const }
  const summary = {
    version: 'strategy-learning-v1',
    date: '2026-05-19',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: strategyLearningEvidence({
        decisions: 900,
        matched: 200,
        match_rate: 0.222222,
        rolling_decisions: 90,
        rolling_matched: 20,
        rolling_match_rate: 0.222222,
        samples: 450,
        hit_rate: 0.44,
        avg_return_pct: -0.006,
        max_drawdown_pct: -0.11,
        rolling_samples: 45,
        rolling_hit_rate: 0.44,
        rolling_avg_return_pct: -0.006,
        rolling_max_drawdown_pct: -0.11,
        rolling_reward_dates: 12,
        rolling_date_return_mean: -0.006,
        rolling_date_return_lcb90: -0.01,
      }),
    }],
    promotion_gate: [],
    replacement_gate: strategyReplacementGateEvidence(),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'active_monitor', 'single-strategy performance diagnostics must not auto-demote an active incumbent')
  assert(gate[0].allocation_eligible === true, 'mature incumbent remains lifecycle-eligible while its negative edge receives zero weight')
  assert(gate[0].recommended_next_status === 'active', 'active lifecycle demotion requires a governed replacement decision')
  assert(gate[0].recommended_stage === 'active', 'mature incumbent remains in Active lifecycle monitoring')
  assert(gate[0].diagnostic_only_metrics.includes('max_drawdown'), 'active MDD must remain diagnostic outside Atomic V7 relative replacement')

  const policy = buildStrategyAdaptivePolicyState({ ...summary, promotion_gate: gate })
  assert(policy.strategy_weights[spec.id] === 1, 'readiness-mature incumbents must keep a neutral adaptive base until the promoted primary-horizon owner changes contribution')
  assert(policy.threshold_deltas[spec.id] == null, 'performance evidence must not rewrite immutable strategy label thresholds')
  assert(policy.lifecycle_recommendations[spec.id].automatic_effect === 'weight_only', 'adaptive policy may only change contribution weight')
  assert(policy.lifecycle_recommendations[spec.id].recommended_status === 'active', 'five-day diagnostics alone must neither demote nor zero the incumbent')
  const applied = applyStrategyAdaptivePolicyThresholds([spec], policy)
  assert(applied[0].thresholds.minVolumeExpansion20 === spec.thresholds.minVolumeExpansion20, 'immutable strategy thresholds must remain unchanged')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'active' as const }
  const summary = {
    version: 'strategy-learning-v5',
    date: '2026-08-14',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: strategyLearningEvidence({
        decisions: 900,
        matched: 200,
        match_rate: 0.222222,
        rolling_decisions: 90,
        rolling_matched: 20,
        rolling_match_rate: 0.222222,
        samples: 450,
        hit_rate: 0.5106,
        avg_return_pct: 0.005824,
        max_drawdown_pct: -0.04,
        rolling_samples: 45,
        rolling_hit_rate: 0.5106,
        rolling_avg_return_pct: 0.005824,
        rolling_max_drawdown_pct: -0.04,
        rolling_reward_dates: 13,
        rolling_date_return_mean: 0.005824,
        rolling_date_return_lcb90: 0.001,
      }),
    }],
    promotion_gate: [],
    replacement_gate: strategyReplacementGateEvidence(),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'active_monitor', 'retained incumbent must remain active-monitor')
  assert(gate[0].allocation_eligible === true, 'mature incumbent evidence must retain lifecycle eligibility without a universal hit-rate threshold')
  assert(gate[0].missing_evidence.length === 0, 'hit-rate diagnostics must not block incumbent retention')
  const policy = buildStrategyAdaptivePolicyState({ ...summary, promotion_gate: gate })
  assert(policy.strategy_weights[spec.id] === 1, 'retained incumbent must receive the available production allocation')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'active' as const }
  const summary = {
    version: 'strategy-learning-v5',
    date: '2026-08-14',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: strategyLearningEvidence({
        rolling_decisions: 90,
        rolling_matched: 20,
        rolling_match_rate: 0.222222,
        rolling_samples: 45,
        rolling_hit_rate: 0.5106,
        rolling_avg_return_pct: 0.004508,
        rolling_max_drawdown_pct: -0.04,
        rolling_reward_dates: 9,
        rolling_date_return_mean: 0.004508,
        rolling_date_return_lcb90: 0.001,
      }),
    }],
    promotion_gate: [],
    replacement_gate: strategyReplacementGateEvidence(),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'active_monitor', 'immature incumbent must remain observable')
  assert(gate[0].allocation_eligible === false, 'incumbent with fewer than 10 mature dates must remain allocation-ineligible')
  assert(gate[0].missing_evidence.includes('mature_dates_lt_10'), 'retention gate must expose the mature-date deficit')
}

{
  const spec = { ...DEFAULT_STRATEGY_SPECS[0], status: 'active' as const }
  const summary = {
    version: 'strategy-learning-v4',
    date: '2026-08-15',
    spec_source: 'registry',
    specs: [{
      ...spec,
      learning: strategyLearningEvidence({
        decisions: 20,
        evaluable_decisions: 20,
        unavailable_decisions: 0,
        rolling_decisions: 20,
        rolling_evaluable_decisions: 20,
        rolling_unavailable_decisions: 0,
        samples: 20,
        rolling_samples: 20,
        hit_rate: 0.4,
        rolling_hit_rate: 0.4,
        avg_return_pct: -0.008,
        rolling_avg_return_pct: -0.008,
        max_drawdown_pct: -0.15,
        rolling_max_drawdown_pct: -0.15,
        rolling_reward_dates: 6,
        rolling_date_return_mean: -0.008,
        rolling_date_return_lcb90: -0.02,
      }),
    }],
    promotion_gate: [],
    replacement_gate: strategyReplacementGateEvidence(),
    policy_state_preview: {} as any,
  } satisfies StrategyLearningSummary
  const gate = evaluateStrategyPromotionGate(summary)
  assert(gate[0].decision === 'active_monitor', 'immature active evidence should remain observable without forced lifecycle demotion')
  assert(gate[0].allocation_eligible === false, 'immature active evidence must be ineligible for production allocation')
  assert(gate[0].recommended_stage === 'active', 'immature Active evidence remains Active while allocation fails closed')
  assert(gate[0].missing_evidence.includes('samples_lt_30'), 'immature active gate must disclose the sample deficit')
  assert(gate[0].missing_evidence.includes('mature_dates_lt_10'), 'immature active gate must disclose the date deficit')
  const policy = buildStrategyAdaptivePolicyState({ ...summary, promotion_gate: gate })
  assert(policy.strategy_weights[spec.id] === 0, 'immature negative-edge active strategy must receive zero production weight')
  assert(policy.evidence.eligible_strategy_count === 0, 'immature active strategy must not count as eligible')
}

{
  const spec = {
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'decision_evaluability_contract_v1',
    status: 'candidate' as const,
    thresholds: { dsl: { all: [{ signal: 'technicalIndicators.contractSignal', op: '>=' as const, value: 1 }] } },
  }
  const [unavailable] = buildStrategyDecisionRows(
    '2026-07-28',
    [{ symbol: '1000', raw_signals: { technicalIndicators: {} } }],
    [spec],
  )
  assert(unavailable.evaluable === 0, 'missing signal decision must be marked unavailable')
  assert(unavailable.matched === 0, 'unavailable decision must not become a hit')
  assert(unavailable.reason_code.startsWith('strategy_spec_unavailable:'), 'unavailable decision must expose a stable reason code')
  const [negative] = buildStrategyDecisionRows(
    '2026-07-28',
    [{ symbol: '1001', raw_signals: { technicalIndicators: { contractSignal: 0 } } }],
    [spec],
  )
  assert(negative.evaluable === 1 && negative.matched === 0, 'present but failing signal must remain an evaluable negative')
}

{
  const source = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
  assert(/r\.market_segment,\r?\n\s+dr\.industry/.test(source), 'daily strategy candidates must preserve selection-reference market_segment lineage')
  assert(source.includes('market_segment: referenceBySymbol.get'), 'historical strategy rebuild must preserve selection-reference market_segment lineage')
}
