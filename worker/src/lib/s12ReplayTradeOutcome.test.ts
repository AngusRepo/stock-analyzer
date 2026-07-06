import {
  loadL0PassedSymbolsByHistoricalDate,
  persistS12ReplayOutcome,
  runS12HistoricalReplayForDate,
  s12ReplayOutcomeToEvSample,
  simulateS12ReplayTradeOutcome,
} from './s12ReplayTradeOutcome'
import type { S12Bar, S12IntradayAssessment } from './s12IntradayStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const M15 = 15 * 60_000
const baseMs = Date.parse('2026-07-02T01:00:00.000Z')

function bar(i: number, open: number, high: number, low: number, close: number): S12Bar {
  return { startMs: baseMs + i * M15, open, high, low, close, volume: 100 + i }
}

function assessment(overrides: Partial<S12IntradayAssessment> = {}): S12IntradayAssessment {
  return {
    version: 's12_intraday_structure_v1',
    symbol: '8091',
    direction: 'long',
    state: 'reaction_ready',
    ready: true,
    invalidated: false,
    reason: 's12_reaction_ready',
    detail: 'state=reaction_ready;ready=true',
    setupId: '8091:setup',
    completedBars: { m15: 5, h1: 1, h4: 1 },
    h4Source: 'current_session',
    h4ReferenceDate: null,
    h4ReferenceClose: null,
    barDiagnostics: {},
    coverage: 'full',
    bias4h: { direction: 'long', confidence: 'confirmed', channelAlign: true },
    bias1h: { direction: 'long', confidence: 'confirmed', channelAlign: true },
    demandZone1h: null,
    supplyZone1h: null,
    bearishDefense: {
      state: 'no_supply_zone',
      ready: false,
      action: 'none',
      reason: 'none',
      detail: '',
      supplyZone1h: null,
      sequence: {},
    },
    defensiveAction: 'none',
    quality: {} as any,
    exitPlan: {
      mode: 'structure_first_trailing_v1',
      tp1: { price: 104, source: '15m_previous_high', action: 'partial_take_profit' },
      mainExit: { price: 108, zoneLow: null, zoneHigh: null, source: '1h_supply_zone', action: 'main_take_profit' },
      tp3: { price: 112, source: 'tp_ladder', action: 'extended_take_profit' },
      tp4: { price: null, source: 'unavailable', action: 'extended_take_profit' },
      manualTp: { price: null, source: 'unavailable', action: 'manual_take_profit' },
      trailingStop: {
        initial: 96,
        method: 'structure_stop_then_15m_higher_low_atr_vwap',
        source: 'adaptive',
        activation: 'after_tp1_or_reverse_choch',
      },
      reverseWarning: { state: null, action: 'none', source: 'bearish_defense_sidecar' },
    },
    sequence: { reactionMs: baseMs + 4 * M15 },
    execution: {
      entryPrice: 100,
      chaseCeiling: 101,
      stopLoss: 96,
      target1: 104,
      target2: 108,
      target3: 112,
      target4: null,
      atr15m: 2,
      rMultiple: 2,
    },
    maturity: {
      takeoverEligible: true,
      takeoverRole: 'long_entry',
      tier: 'full_reaction_ready',
      riskMode: 'full_size_reaction',
      policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
      blocker: 'reaction_ready',
      stage: 'ready',
    },
    ...overrides,
  }
}

{
  const bars = [
    bar(0, 98, 100, 97, 99),
    bar(1, 99, 101, 98, 100),
    bar(2, 100, 102, 99, 101),
    bar(3, 101, 102, 100, 101),
    bar(4, 99, 101, 98, 100),
    bar(5, 100, 105, 99, 104),
    bar(6, 104, 109, 103, 108),
    bar(7, 108, 113, 107, 112),
  ]
  const outcome = simulateS12ReplayTradeOutcome(
    { symbol: '8091', tradeDate: '2026-07-02', baseBars: bars },
    { entryAssessment: assessment(), assessmentProvider: () => assessment() },
  )
  assert(outcome.status === 'executed', 'reaction_ready replay should produce executed outcome')
  assert(outcome.sample_eligible === true, 'executed replay should be sample eligible')
  assert(outcome.exit_reason === 'tp3', 'TP ladder should finish at tp3 when all targets hit')
  assert(outcome.pnl_pct != null && Math.abs(outcome.pnl_pct - 0.08) < 0.000001, 'three equal tranches should average 4/8/12% into 8%')
  assert(outcome.trade_pnl_r === 2, '8% pnl on 4% risk should be 2R')
  const sample = s12ReplayOutcomeToEvSample(outcome)
  assert(sample?.exit_reason === 'tp3', 'EV sample should preserve exit reason')
  assert(sample?.return_pct === outcome.pnl_pct, 'EV sample should expose return_pct')
}

{
  const bars = [
    bar(0, 98, 100, 97, 99),
    bar(1, 99, 101, 98, 100),
    bar(2, 100, 102, 99, 101),
    bar(3, 101, 102, 100, 101),
    bar(4, 99, 101, 98, 100),
    bar(5, 100, 105, 95, 104),
  ]
  const outcome = simulateS12ReplayTradeOutcome(
    { symbol: '8091', tradeDate: '2026-07-02', baseBars: bars },
    { entryAssessment: assessment(), assessmentProvider: () => assessment() },
  )
  assert(outcome.exit_reason === 'structure_stop', 'same-bar stop/target ambiguity must resolve stop first')
  assert(outcome.pnl_pct === -0.04, 'structure stop should realize -4%')
}

{
  const setup = assessment({
    state: 'waiting_retest',
    ready: false,
    reason: 's12_waiting_retest',
    detail: 'state=waiting_retest;ready=false',
  })
  const outcome = simulateS12ReplayTradeOutcome(
    { symbol: '8091', tradeDate: '2026-07-02', baseBars: [bar(0, 100, 101, 99, 100)] },
    { entryAssessment: setup, assessmentProvider: () => setup },
  )
  assert(outcome.status === 'setup_only', 'setup-valid states must not become executed replay samples')
  assert(outcome.sample_eligible === false, 'setup-only replay must not feed trade EV')
  assert(s12ReplayOutcomeToEvSample(outcome) == null, 'setup-only outcome should not convert to EV sample')
}

{
  const setup = assessment({
    state: 'waiting_sweep',
    ready: false,
    reason: 's12_equity_mutation_context_ready',
    detail: 'state=waiting_sweep;reason=s12_equity_mutation_context_ready;equity_mutation_context=true;entry_archetype=equity_repricing_breakout',
    sequence: { zoneTouchMs: baseMs + 4 * M15 },
    maturity: {
      takeoverEligible: false,
      takeoverRole: 'none',
      tier: 'none',
      riskMode: 'none',
      policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
      blocker: 'waiting_sweep',
      stage: 'trigger_sequence',
    },
  })
  const bars = [
    bar(0, 98, 100, 97, 99),
    bar(1, 99, 101, 98, 100),
    bar(2, 100, 102, 99, 101),
    bar(3, 101, 102, 100, 101),
    bar(4, 99, 101, 98, 100),
    bar(5, 100, 105, 99, 104),
    bar(6, 104, 109, 103, 108),
  ]
  const outcome = simulateS12ReplayTradeOutcome(
    { symbol: '8091', tradeDate: '2026-07-02', baseBars: bars },
    { entryAssessment: setup, assessmentProvider: () => setup },
  )
  assert(outcome.status === 'executed', 'S12 equity-mutation setup-valid replay should simulate an entry')
  assert(outcome.status_reason === 'executed_equity_mutation_context_ready', 'S12 equity-mutation replay should preserve entry provenance')
  assert(outcome.sample_eligible === true, 'S12 equity-mutation replay should feed trade EV samples')
}

{
  let calls = 0
  const bars = [
    bar(0, 98, 100, 97, 99),
    bar(1, 99, 101, 98, 100),
    bar(2, 100, 102, 99, 101),
    bar(3, 101, 102, 100, 101),
    bar(4, 99, 101, 98, 100),
    bar(5, 100, 103, 99, 102),
    bar(6, 102, 103, 100, 101),
  ]
  const provider = () => {
    calls += 1
    if (calls >= 2) {
      return assessment({ state: 'bearish_defense_ready', ready: false, defensiveAction: 'NO_BUY' })
    }
    return assessment()
  }
  const outcome = simulateS12ReplayTradeOutcome(
    { symbol: '8091', tradeDate: '2026-07-02', baseBars: bars },
    { entryAssessment: assessment(), assessmentProvider: provider },
  )
  assert(outcome.exit_reason === 'bearish_defense_exit', 'bearish defense should exit remaining position')
}

async function runAsyncTests(): Promise<void> {
  const queries: { sql: string; params: unknown[] }[] = []
  const fakeDb = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first() {
              queries.push({ sql, params })
              return { run_id: 'run-1' }
            },
            async all() {
              queries.push({ sql, params })
              return {
                results: [
                  { symbol: '8091', name: 'A', score_after: 88, rank: 1, evidence: '{}' },
                  { symbol: '', name: 'bad', score_after: 1, rank: 2, evidence: '{}' },
                ],
              }
            },
          }
        },
      }
    },
  } as any
  const rows = await loadL0PassedSymbolsByHistoricalDate(fakeDb, '2026-07-02')
  assert(rows.length === 1 && rows[0].symbol === '8091', 'L0 loader should return latest pass symbols only')
  assert(queries[0].sql.includes('FROM screener_funnel_runs'), 'L0 loader should use screener run source of truth')
  assert(queries[1].sql.includes("stage = 'universe'"), 'L0 loader should read universe pass stage')
}

void runAsyncTests().catch((error) => {
  throw error
})

async function runPersistenceTests(): Promise<void> {
  const binds: unknown[][] = []
  const fakeDb = {
    prepare(sql: string) {
      assert(sql.includes('s12_replay_trade_outcomes'), 'persist should write dedicated replay table')
      return {
        bind(...params: unknown[]) {
          binds.push(params)
          return { async run() { return {} } }
        },
      }
    },
  } as any
  await persistS12ReplayOutcome(fakeDb, {
    schema_version: 's12-replay-trade-outcome-v1',
    symbol: '8091',
    trade_date: '2026-07-02',
    status: 'executed',
    sample_eligible: true,
    source: 's12_intraday_structure_replay_v1',
    assessment_state: 'reaction_ready',
    status_reason: 'executed_reaction_ready',
    setup_id: '8091:setup',
    entry_ms: baseMs,
    exit_ms: baseMs + M15,
    entry_price: 100,
    stop_price: 96,
    target1_price: 104,
    target2_price: 108,
    target3_price: 112,
    exit_price: 104,
    pnl_pct: 0.04,
    trade_pnl_r: 1,
    mfe_pct: 0.05,
    mae_pct: -0.01,
    bars_to_exit: 1,
    exit_reason: 'tp1',
    conservative_intrabar_order: 'stop_before_target',
    assessment_detail: 'state=reaction_ready;equity_mutation_context=true;vwap_fast_acceptance=true',
    replay_diagnostics: { source: 'historical_asof' },
  })
  assert(binds.length === 1, 'persist should execute one upsert')
  assert(binds[0][0] === '8091' && binds[0][18] === 1, 'persist should bind symbol and sample_eligible')
  const detail = JSON.parse(String(binds[0][20])) as Record<string, unknown>
  assert(String(detail.assessment_detail).includes('equity_mutation_context=true'), 'persisted detail should retain SMCVWAP diagnostics')
  assert((detail.replay_diagnostics as Record<string, unknown>).source === 'historical_asof', 'persisted detail should retain replay loader diagnostics')
}

void runPersistenceTests().catch((error) => {
  throw error
})

async function runHistoricalReplayRunnerTests(): Promise<void> {
  let writes = 0
  const fakeEnv = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                writes += 1
                return {}
              },
            }
          },
        }
      },
    },
  } as any
  const summary = await runS12HistoricalReplayForDate(fakeEnv, '2026-07-02', {
    symbols: [{ symbol: '8091' }, { symbol: '2330' }],
    loadBars: async () => ({ bars: [] }),
  })
  assert(summary.schema_version === 's12-historical-replay-run-summary-v1', 'runner should return stable summary contract')
  assert(summary.attempted === 2, 'runner should attempt supplied L0 symbols')
  assert(summary.skipped === 2, 'empty bars should produce skipped replay outcomes')
  assert(summary.persisted === 2 && writes === 2, 'runner should persist every replay outcome by default')

  const offsetSummary = await runS12HistoricalReplayForDate(fakeEnv, '2026-07-02', {
    symbols: [{ symbol: '1111' }, { symbol: '2222' }, { symbol: '3333' }],
    offset: 1,
    limit: 1,
    persist: false,
    loadBars: async (symbol) => {
      assert(symbol === '2222', 'runner offset should select the requested L0 slice')
      return { bars: [] }
    },
  })
  assert(offsetSummary.attempted === 1 && offsetSummary.persisted === 0, 'runner should support dry-run offset slices')
}

void runHistoricalReplayRunnerTests().catch((error) => {
  throw error
})
