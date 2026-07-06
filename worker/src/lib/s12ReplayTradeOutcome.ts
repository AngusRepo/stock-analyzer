import {
  assessS12IntradayStructureFromBaseBars,
  type S12Bar,
  type S12IntradayAssessment,
  type S12TimingPolicy,
} from './s12IntradayStructure'
import { loadS12HistoricalReplayBars } from './s12RuntimeBars'
import type { Bindings } from '../types'

export type S12ReplayOutcomeStatus = 'executed' | 'setup_only' | 'skipped'

export interface S12ReplayOutcome {
  schema_version: 's12-replay-trade-outcome-v1'
  symbol: string
  trade_date: string
  status: S12ReplayOutcomeStatus
  sample_eligible: boolean
  source: 's12_intraday_structure_replay_v1'
  assessment_state: string | null
  status_reason: string
  setup_id: string | null
  entry_ms: number | null
  exit_ms: number | null
  entry_price: number | null
  stop_price: number | null
  target1_price: number | null
  target2_price: number | null
  target3_price: number | null
  exit_price: number | null
  pnl_pct: number | null
  trade_pnl_r: number | null
  mfe_pct: number | null
  mae_pct: number | null
  bars_to_exit: number | null
  exit_reason: string | null
  conservative_intrabar_order: 'stop_before_target'
  assessment_ready?: boolean | null
  assessment_reason?: string | null
  assessment_detail?: string | null
  assessment_completed_bars?: S12IntradayAssessment['completedBars'] | null
  assessment_bar_diagnostics?: S12IntradayAssessment['barDiagnostics'] | null
  assessment_maturity?: S12IntradayAssessment['maturity'] | null
  assessment_execution?: S12IntradayAssessment['execution'] | null
  assessment_sequence?: S12IntradayAssessment['sequence'] | null
  replay_diagnostics?: Record<string, unknown> | null
}

export interface S12ReplayInput {
  symbol: string
  tradeDate: string
  baseBars: S12Bar[]
  fallback15mBars?: S12Bar[]
  fallback1hBars?: S12Bar[]
  fallback4hBars?: S12Bar[]
  policy?: Partial<S12TimingPolicy> | null
  h4ReferenceDate?: string | null
  h4ReferenceClose?: number | null
  replayDiagnostics?: Record<string, unknown> | null
}

export interface S12ReplayOptions {
  entryAssessment?: S12IntradayAssessment | null
  assessmentProvider?: (bars: S12Bar[], nowMs: number) => S12IntradayAssessment
  maxExitBars?: number
}

export interface S12ReplayBars {
  bars: S12Bar[]
  fallback15mBars?: S12Bar[]
  fallback1hBars?: S12Bar[]
  fallback4hBars?: S12Bar[]
  h4ReferenceDate?: string | null
  h4ReferenceClose?: number | null
  diagnostics?: Record<string, unknown>
}

export interface S12HistoricalReplayRunOptions {
  symbols?: S12L0PassedSymbol[]
  limit?: number
  offset?: number
  persist?: boolean
  loadBars?: (symbol: string, tradeDate: string) => Promise<S12ReplayBars>
}

export interface S12HistoricalReplayRunSummary {
  schema_version: 's12-historical-replay-run-summary-v1'
  trade_date: string
  l0_symbols: number
  attempted: number
  executed: number
  setup_only: number
  skipped: number
  persisted: number
  outcomes: S12ReplayOutcome[]
}

export interface S12L0PassedSymbol {
  symbol: string
  name?: string | null
  score_after?: number | null
  rank?: number | null
  evidence?: string | null
}

const M15_MS = 15 * 60_000

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function round(value: number | null, digits = 10): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function normalizeBars(bars: S12Bar[]): S12Bar[] {
  return [...(bars ?? [])]
    .filter((bar) => (
      Number.isFinite(bar.startMs) &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.high >= bar.low
    ))
    .sort((a, b) => a.startMs - b.startMs)
}

function defaultAssessmentProvider(input: S12ReplayInput) {
  return (bars: S12Bar[], nowMs: number): S12IntradayAssessment => assessS12IntradayStructureFromBaseBars({
    symbol: input.symbol,
    baseBars: bars,
    fallback15mBars: input.fallback15mBars ?? [],
    fallback1hBars: input.fallback1hBars ?? [],
    fallback4hBars: input.fallback4hBars ?? [],
    nowMs,
    policy: input.policy,
    h4ReferenceDate: input.h4ReferenceDate,
    h4ReferenceClose: input.h4ReferenceClose,
  })
}

function isSetupValidState(state: string | null | undefined): boolean {
  return [
    'waiting_sweep',
    'waiting_choch',
    'waiting_bos',
    'waiting_retest',
  ].includes(String(state ?? ''))
}

function isEquityMutationReplayEntry(assessment: S12IntradayAssessment): boolean {
  const detail = String(assessment.detail ?? '')
  const entry = finitePositive(assessment.execution.entryPrice)
  const stop = finitePositive(assessment.exitPlan.trailingStop.initial) ?? finitePositive(assessment.execution.stopLoss)
  return (
    assessment.reason === 's12_equity_mutation_context_ready' &&
    detail.includes('equity_mutation_context=true') &&
    detail.includes('entry_archetype=equity_repricing_breakout') &&
    entry != null &&
    stop != null &&
    stop < entry
  )
}

function isReplayEntryAssessment(assessment: S12IntradayAssessment): boolean {
  return (assessment.state === 'reaction_ready' && assessment.ready) || isEquityMutationReplayEntry(assessment)
}

function replayEntryStatusReason(assessment: S12IntradayAssessment): string {
  if (isEquityMutationReplayEntry(assessment)) return 'executed_equity_mutation_context_ready'
  return 'executed_reaction_ready'
}

function assessmentSnapshot(assessment?: S12IntradayAssessment | null): Pick<
  S12ReplayOutcome,
  | 'assessment_ready'
  | 'assessment_reason'
  | 'assessment_detail'
  | 'assessment_completed_bars'
  | 'assessment_bar_diagnostics'
  | 'assessment_maturity'
  | 'assessment_execution'
  | 'assessment_sequence'
> {
  return {
    assessment_ready: assessment?.ready ?? null,
    assessment_reason: assessment?.reason ?? null,
    assessment_detail: assessment?.detail ?? null,
    assessment_completed_bars: assessment?.completedBars ?? null,
    assessment_bar_diagnostics: assessment?.barDiagnostics ?? null,
    assessment_maturity: assessment?.maturity ?? null,
    assessment_execution: assessment?.execution ?? null,
    assessment_sequence: assessment?.sequence ?? null,
  }
}

function emptyOutcome(input: S12ReplayInput, status: S12ReplayOutcomeStatus, reason: string, assessment?: S12IntradayAssessment | null): S12ReplayOutcome {
  return {
    schema_version: 's12-replay-trade-outcome-v1',
    symbol: input.symbol,
    trade_date: input.tradeDate,
    status,
    sample_eligible: false,
    source: 's12_intraday_structure_replay_v1',
    assessment_state: assessment?.state ?? null,
    status_reason: reason,
    setup_id: assessment?.setupId ?? null,
    entry_ms: null,
    exit_ms: null,
    entry_price: null,
    stop_price: null,
    target1_price: null,
    target2_price: null,
    target3_price: null,
    exit_price: null,
    pnl_pct: null,
    trade_pnl_r: null,
    mfe_pct: null,
    mae_pct: null,
    bars_to_exit: null,
    exit_reason: null,
    conservative_intrabar_order: 'stop_before_target',
    ...assessmentSnapshot(assessment),
    replay_diagnostics: input.replayDiagnostics ?? null,
  }
}

function findEntryAssessment(
  input: S12ReplayInput,
  bars: S12Bar[],
  provider: (bars: S12Bar[], nowMs: number) => S12IntradayAssessment,
  preset?: S12IntradayAssessment | null,
): S12IntradayAssessment | null {
  if (preset) return preset
  let latestSetup: S12IntradayAssessment | null = null
  for (let i = 0; i < bars.length; i += 1) {
    const nowMs = bars[i].startMs + M15_MS
    const assessment = provider(bars.slice(0, i + 1), nowMs)
    if (isReplayEntryAssessment(assessment)) return assessment
    if (isSetupValidState(assessment.state)) latestSetup = assessment
  }
  return latestSetup ?? null
}

function targetLadder(assessment: S12IntradayAssessment): number[] {
  const entry = finitePositive(assessment.execution.entryPrice)
  const raw = [
    finitePositive(assessment.execution.target1) ?? finitePositive(assessment.exitPlan.tp1.price),
    finitePositive(assessment.execution.target2) ?? finitePositive(assessment.exitPlan.mainExit.price),
    finitePositive(assessment.execution.target3) ?? finitePositive(assessment.exitPlan.tp3.price),
  ]
  const out: number[] = []
  for (const target of raw) {
    if (entry != null && target != null && target > entry && !out.some((x) => Math.abs(x - target) < 0.000001)) {
      out.push(target)
    }
  }
  return out
}

export function simulateS12ReplayTradeOutcome(input: S12ReplayInput, options: S12ReplayOptions = {}): S12ReplayOutcome {
  const bars = normalizeBars(input.baseBars)
  if (bars.length === 0) return emptyOutcome(input, 'skipped', 'missing_intraday_bars')

  const provider = options.assessmentProvider ?? defaultAssessmentProvider(input)
  const assessment = findEntryAssessment(input, bars, provider, options.entryAssessment)
  if (!assessment) return emptyOutcome(input, 'skipped', 'no_s12_assessment')
  if (!isReplayEntryAssessment(assessment)) {
    return emptyOutcome(input, isSetupValidState(assessment.state) ? 'setup_only' : 'skipped', `s12_state_${assessment.state}`, assessment)
  }

  const entry = finitePositive(assessment.execution.entryPrice)
  const stop = finitePositive(assessment.exitPlan.trailingStop.initial) ?? finitePositive(assessment.execution.stopLoss)
  if (entry == null || stop == null || stop >= entry) {
    return emptyOutcome(input, 'skipped', 'invalid_entry_or_stop', assessment)
  }

  const entryMs = Number(assessment.sequence.reactionMs ?? assessment.sequence.zoneTouchMs ?? 0)
  const foundEntryIndex = bars.findIndex((bar) => bar.startMs >= entryMs)
  const entryIndex = foundEntryIndex >= 0 ? foundEntryIndex : bars.length - 1
  const futureBars = bars.slice(entryIndex + 1, entryIndex + 1 + Math.max(1, Math.floor(options.maxExitBars ?? 80)))
  if (futureBars.length === 0) return emptyOutcome(input, 'skipped', 'missing_post_entry_bars', assessment)

  const targets = targetLadder(assessment)
  const tranches = targets.map((price, index) => ({
    price,
    ratio: index === targets.length - 1 ? 1 : 1 / Math.max(1, targets.length),
    label: `tp${index + 1}`,
  }))
  let nextTarget = 0
  let remaining = 1
  let realized = 0
  let activeStop = stop
  let exitPrice: number | null = null
  let exitMs: number | null = null
  let exitReason: string | null = null
  let barsToExit: number | null = null
  let maxHigh = entry
  let minLow = entry

  for (let i = 0; i < futureBars.length; i += 1) {
    const bar = futureBars[i]
    maxHigh = Math.max(maxHigh, bar.high)
    minLow = Math.min(minLow, bar.low)

    if (bar.low <= activeStop) {
      realized += remaining * ((activeStop - entry) / entry)
      remaining = 0
      exitPrice = activeStop
      exitMs = bar.startMs
      exitReason = nextTarget > 0 ? 'trailing_structure_stop' : 'structure_stop'
      barsToExit = i + 1
      break
    }

    const defense = provider(bars.slice(0, entryIndex + 2 + i), bar.startMs + M15_MS)
    if (defense.state === 'bearish_defense_ready' || defense.defensiveAction === 'EXIT_ON_REVERSE_BOS') {
      realized += remaining * ((bar.close - entry) / entry)
      remaining = 0
      exitPrice = bar.close
      exitMs = bar.startMs
      exitReason = 'bearish_defense_exit'
      barsToExit = i + 1
      break
    }

    while (nextTarget < tranches.length && bar.high >= tranches[nextTarget].price && remaining > 0) {
      const target = tranches[nextTarget]
      const sellRatio = Math.min(remaining, target.ratio)
      realized += sellRatio * ((target.price - entry) / entry)
      remaining -= sellRatio
      exitPrice = target.price
      exitMs = bar.startMs
      exitReason = target.label
      barsToExit = i + 1
      nextTarget += 1
      if (nextTarget === 1) activeStop = Math.max(activeStop, entry)
    }

    if (remaining <= 0) break
  }

  if (remaining > 0) {
    const last = futureBars[futureBars.length - 1]
    realized += remaining * ((last.close - entry) / entry)
    exitPrice = last.close
    exitMs = last.startMs
    exitReason = exitReason ?? 'time_exit'
    barsToExit = futureBars.length
  }

  const riskPct = (entry - stop) / entry
  return {
    schema_version: 's12-replay-trade-outcome-v1',
    symbol: input.symbol,
    trade_date: input.tradeDate,
    status: 'executed',
    sample_eligible: true,
    source: 's12_intraday_structure_replay_v1',
    assessment_state: assessment.state,
    status_reason: replayEntryStatusReason(assessment),
    setup_id: assessment.setupId,
    entry_ms: entryMs || null,
    exit_ms: exitMs,
    entry_price: round(entry, 6),
    stop_price: round(stop, 6),
    target1_price: round(targets[0] ?? null, 6),
    target2_price: round(targets[1] ?? null, 6),
    target3_price: round(targets[2] ?? null, 6),
    exit_price: round(exitPrice, 6),
    pnl_pct: round(realized, 10),
    trade_pnl_r: round(riskPct > 0 ? realized / riskPct : null, 6),
    mfe_pct: round((maxHigh - entry) / entry, 10),
    mae_pct: round((minLow - entry) / entry, 10),
    bars_to_exit: barsToExit,
    exit_reason: exitReason,
    conservative_intrabar_order: 'stop_before_target',
    ...assessmentSnapshot(assessment),
    replay_diagnostics: input.replayDiagnostics ?? null,
  }
}

export function s12ReplayOutcomeToEvSample(outcome: S12ReplayOutcome): Record<string, unknown> | null {
  if (!outcome.sample_eligible || outcome.status !== 'executed' || outcome.pnl_pct == null) return null
  return {
    return_pct: outcome.pnl_pct,
    pnl_pct: outcome.pnl_pct,
    trade_pnl_r: outcome.trade_pnl_r,
    mfe_pct: outcome.mfe_pct,
    mae_pct: outcome.mae_pct,
    bars_to_exit: outcome.bars_to_exit,
    exit_reason: outcome.exit_reason ?? 'unknown',
  }
}

export async function loadL0PassedSymbolsByHistoricalDate(
  db: D1Database,
  tradeDate: string,
): Promise<S12L0PassedSymbol[]> {
  const run = await db.prepare(`
    SELECT run_id
      FROM screener_funnel_runs
     WHERE date = ?
       AND status = 'success'
     ORDER BY created_at DESC
     LIMIT 1
  `).bind(tradeDate).first<{ run_id: string }>()
  if (!run?.run_id) return []
  const { results } = await db.prepare(`
    SELECT symbol, name, score_after, rank, evidence
      FROM screener_funnel_items
     WHERE run_id = ?
       AND date = ?
       AND stage = 'universe'
       AND decision = 'pass'
     ORDER BY COALESCE(rank, 999999), symbol
  `).bind(run.run_id, tradeDate).all<S12L0PassedSymbol>()
  return (results ?? []).map((row) => ({
    symbol: String(row.symbol ?? '').trim(),
    name: row.name ?? null,
    score_after: row.score_after ?? null,
    rank: row.rank ?? null,
    evidence: row.evidence ?? null,
  })).filter((row) => row.symbol)
}

export async function persistS12ReplayOutcome(
  db: D1Database,
  outcome: S12ReplayOutcome,
): Promise<void> {
  const setupId = outcome.setup_id ?? `${outcome.symbol}:${outcome.trade_date}:${outcome.status_reason}`
  await db.prepare(`
    INSERT INTO s12_replay_trade_outcomes (
      symbol, trade_date, assessment_state, setup_id,
      entry_ms, exit_ms, entry_price, stop_price,
      target1_price, target2_price, target3_price, exit_price,
      pnl_pct, trade_pnl_r, max_favorable_pct, max_adverse_pct,
      bars_to_exit, exit_reason, sample_eligible, source, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, trade_date, setup_id) DO UPDATE SET
      assessment_state=excluded.assessment_state,
      entry_ms=excluded.entry_ms,
      exit_ms=excluded.exit_ms,
      entry_price=excluded.entry_price,
      stop_price=excluded.stop_price,
      target1_price=excluded.target1_price,
      target2_price=excluded.target2_price,
      target3_price=excluded.target3_price,
      exit_price=excluded.exit_price,
      pnl_pct=excluded.pnl_pct,
      trade_pnl_r=excluded.trade_pnl_r,
      max_favorable_pct=excluded.max_favorable_pct,
      max_adverse_pct=excluded.max_adverse_pct,
      bars_to_exit=excluded.bars_to_exit,
      exit_reason=excluded.exit_reason,
      sample_eligible=excluded.sample_eligible,
      source=excluded.source,
      detail_json=excluded.detail_json
  `).bind(
    outcome.symbol,
    outcome.trade_date,
    outcome.assessment_state,
    setupId,
    outcome.entry_ms,
    outcome.exit_ms,
    outcome.entry_price,
    outcome.stop_price,
    outcome.target1_price,
    outcome.target2_price,
    outcome.target3_price,
    outcome.exit_price,
    outcome.pnl_pct,
    outcome.trade_pnl_r,
    outcome.mfe_pct,
    outcome.mae_pct,
    outcome.bars_to_exit,
    outcome.exit_reason,
    outcome.sample_eligible ? 1 : 0,
    outcome.source,
    JSON.stringify(outcome),
  ).run()
}

export async function runS12HistoricalReplayForDate(
  env: Bindings,
  tradeDate: string,
  options: S12HistoricalReplayRunOptions = {},
): Promise<S12HistoricalReplayRunSummary> {
  const l0 = options.symbols ?? await loadL0PassedSymbolsByHistoricalDate(env.DB, tradeDate)
  const requestedLimit = options.limit ?? (l0.length || 1)
  const limit = Math.max(1, Math.min(5000, Math.floor(Number(requestedLimit))))
  const offset = Math.max(0, Math.floor(Number(options.offset ?? 0)))
  const selected = l0.slice(offset, offset + limit)
  const outcomes: S12ReplayOutcome[] = []
  let persisted = 0
  for (const row of selected) {
    const loadBars = options.loadBars ?? (async (symbol: string, date: string) => {
      const loaded = await loadS12HistoricalReplayBars(env, symbol, date)
      return {
        bars: loaded.bars,
        fallback15mBars: loaded.fallback15mBars,
        fallback1hBars: loaded.fallback1hBars,
        fallback4hBars: loaded.fallback4hBars,
        h4ReferenceDate: loaded.diagnostics.previous_4h_reference_date ?? null,
        h4ReferenceClose: Number(loaded.diagnostics.previous_4h_reference_close ?? 0) || null,
        diagnostics: loaded.diagnostics,
      }
    })
    const loaded = await loadBars(row.symbol, tradeDate)
    const outcome = simulateS12ReplayTradeOutcome({
      symbol: row.symbol,
      tradeDate,
      baseBars: loaded.bars,
      fallback15mBars: loaded.fallback15mBars,
      fallback1hBars: loaded.fallback1hBars,
      fallback4hBars: loaded.fallback4hBars,
      h4ReferenceDate: loaded.h4ReferenceDate,
      h4ReferenceClose: loaded.h4ReferenceClose,
      replayDiagnostics: loaded.diagnostics ?? null,
    })
    outcomes.push(outcome)
    if (options.persist !== false) {
      await persistS12ReplayOutcome(env.DB, outcome)
      persisted += 1
    }
  }
  return {
    schema_version: 's12-historical-replay-run-summary-v1',
    trade_date: tradeDate,
    l0_symbols: l0.length,
    attempted: selected.length,
    executed: outcomes.filter((outcome) => outcome.status === 'executed').length,
    setup_only: outcomes.filter((outcome) => outcome.status === 'setup_only').length,
    skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    persisted,
    outcomes,
  }
}
