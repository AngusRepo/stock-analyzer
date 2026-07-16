import {
  assessS12IntradayStructureFromBaseBars,
  type S12Bar,
  type S12IntradayAssessment,
  type S12TimingPolicy,
} from './s12IntradayStructure'
import {
  loadS12HistoricalReplayLifecycleBars,
  s12ResearchTerminalDataSourceReason,
} from './s12RuntimeBars'
import type { Bindings } from '../types'
import {
  S12_REPLAY_ENGINE_SIGNATURE,
  S12_REPLAY_FIVE_SESSION_UPPER_MULTIPLIER,
  S12_REPLAY_TARGET_PRICE_DOMAIN_CONTRACT,
} from './s12ReplayContract'
export { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'

export const ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD =
  'prediction_before_next_executable_session_open;exact_active8_artifact_lineage;l4_trained_before_snapshot;s12_samples_before_run'
import {
  applyS12TwCalibrationArtifact,
  listApprovedS12TwCalibrationArtifacts,
  resolveS12TwCalibrationArtifact,
} from './s12TwEquityCalibration'
import type { S12TwExitCalibration } from './s12TwEquityCalibration'
import { normalizeTwEquityTargetPrice } from './twEquityMarketContract'
import { acquireS12ResearchLease, releaseS12ResearchLease } from './s12ResearchLease'

export type S12ReplayOutcomeStatus = 'executed' | 'setup_only' | 'skipped'

export interface S12ReplayOutcome {
  schema_version: 's12-replay-trade-outcome-v3'
  symbol: string
  signal_date: string
  trade_date: string
  status: S12ReplayOutcomeStatus
  sample_eligible: boolean
  source: 's12_multisession_structure_replay_v3'
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
  market_segment?: string | null
  alpha_bucket?: string | null
  alpha_context?: Record<string, unknown> | null
  alpha_allocation?: Record<string, unknown> | null
  replay_diagnostics?: Record<string, unknown> | null
  market?: string | null
}

export interface S12ReplayInput {
  symbol: string
  signalDate?: string
  tradeDate: string
  baseBars: S12Bar[]
  fallback15mBars?: S12Bar[]
  fallback1hBars?: S12Bar[]
  fallback4hBars?: S12Bar[]
  fallbackDailyBars?: S12Bar[]
  policy?: Partial<S12TimingPolicy> | null
  h4ReferenceDate?: string | null
  h4ReferenceClose?: number | null
  marketSegment?: string | null
  market?: string | null
  alphaBucket?: string | null
  alphaContext?: Record<string, unknown> | null
  alphaAllocation?: Record<string, unknown> | null
  replayDiagnostics?: Record<string, unknown> | null
  exitCalibration?: S12TwExitCalibration | null
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
  fallbackDailyBars?: S12Bar[]
  h4ReferenceDate?: string | null
  h4ReferenceClose?: number | null
  diagnostics?: Record<string, unknown>
  horizonComplete?: boolean
}

export interface S12HistoricalReplayRunOptions {
  symbols?: S12L0PassedSymbol[]
  limit?: number
  offset?: number
  persist?: boolean
  loadBars?: (symbol: string, tradeDate: string) => Promise<S12ReplayBars>
  resolveExecutionDate?: (symbol: string, signalDate: string) => Promise<string | null>
  maturityAsOfDate?: string
}

export interface S12HistoricalReplayRunSummary {
  schema_version: 's12-historical-replay-run-summary-v3'
  signal_date: string
  execution_dates: string[]
  unresolved_execution_dates: number
  l0_symbols: number
  attempted: number
  executed: number
  setup_only: number
  skipped: number
  persisted: number
  terminal_data_source_reason: string | null
  outcomes: S12ReplayOutcome[]
}

export interface S12L0PassedSymbol {
  symbol: string
  name?: string | null
  score_after?: number | null
  rank?: number | null
  evidence?: string | null
  market_segment?: string | null
  market?: string | null
  alpha_context?: string | null
  alpha_allocation?: string | null
}

export async function loadFusionSnapshotMissingReplaySymbols(
  db: D1Database,
  signalDate: string,
  maturityAsOfDate = '9999-12-31',
): Promise<S12L0PassedSymbol[]> {
  const { results } = await db.prepare(`
    WITH latest_snapshot AS (
      SELECT fs.*,
             ROW_NUMBER() OVER (
               PARTITION BY fs.symbol
               ORDER BY fs.generated_at DESC, fs.snapshot_source DESC
             ) AS snapshot_rank
        FROM allocator_ev_feature_snapshots fs
       WHERE fs.snapshot_date = ?
         AND json_extract(fs.score_components, '$.version') = 'score_v2'
         AND fs.snapshot_source = 'allocator_ev_asof_backfill_v2'
         AND fs.as_of_guard = '${ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD}'
    )
    SELECT fs.symbol,
           st.name,
           dr.score AS score_after,
           dr.rank,
           st.market,
           fs.market_segment,
           fs.alpha_context,
           fs.alpha_allocation
      FROM latest_snapshot fs
      LEFT JOIN daily_recommendations dr
        ON dr.date = fs.snapshot_date
       AND dr.symbol = fs.symbol
      LEFT JOIN stocks st
        ON st.symbol = fs.symbol
     WHERE fs.snapshot_rank = 1
       AND (
         SELECT COUNT(DISTINCT date(sp.date))
           FROM stock_prices sp
           JOIN stocks price_stock ON price_stock.id = sp.stock_id
          WHERE price_stock.symbol = fs.symbol
            AND date(sp.date) > date(fs.snapshot_date)
            AND date(sp.date) <= date(?)
            AND sp.open IS NOT NULL
            AND sp.high IS NOT NULL
            AND sp.low IS NOT NULL
            AND sp.close IS NOT NULL
       ) >= 5
       AND NOT EXISTS (
         SELECT 1
           FROM s12_replay_trade_outcomes replay
          WHERE replay.signal_date = fs.snapshot_date
            AND replay.symbol = fs.symbol
            AND replay.source = 's12_multisession_structure_replay_v3'
       )
     ORDER BY COALESCE(dr.rank, 999999), fs.symbol
  `).bind(signalDate, maturityAsOfDate).all<S12L0PassedSymbol>()
  return (results ?? []).map((row) => ({
    symbol: String(row.symbol ?? '').trim(),
    name: row.name ?? null,
    score_after: row.score_after ?? null,
    rank: row.rank ?? null,
    market: row.market ?? null,
    market_segment: row.market_segment ?? null,
    alpha_context: row.alpha_context ?? null,
    alpha_allocation: row.alpha_allocation ?? null,
  })).filter((row) => row.symbol)
}

export interface FusionSnapshotReplayCoverage {
  totalSnapshotRows: number
  replayRows: number
  matureMissingRows: number
  pendingMaturityRows: number
}

export async function loadFusionSnapshotReplayCoverage(
  db: D1Database,
  signalDate: string,
  maturityAsOfDate: string,
): Promise<FusionSnapshotReplayCoverage> {
  const row = await db.prepare(`
    WITH cohort AS (
      SELECT fs.symbol
        FROM allocator_ev_feature_snapshots fs
       WHERE fs.snapshot_date = ?
         AND fs.snapshot_source = 'allocator_ev_asof_backfill_v2'
         AND fs.as_of_guard = '${ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD}'
         AND json_extract(fs.score_components, '$.version') = 'score_v2'
       GROUP BY fs.symbol
    ), coverage AS (
      SELECT
        cohort.symbol,
        EXISTS (
          SELECT 1
            FROM s12_replay_trade_outcomes replay
           WHERE replay.signal_date = ?
             AND replay.symbol = cohort.symbol
             AND replay.source = 's12_multisession_structure_replay_v3'
        ) AS has_replay,
        (
          SELECT COUNT(DISTINCT date(sp.date))
            FROM stock_prices sp
            JOIN stocks st ON st.id = sp.stock_id
           WHERE st.symbol = cohort.symbol
             AND date(sp.date) > date(?)
             AND date(sp.date) <= date(?)
             AND sp.open IS NOT NULL
             AND sp.high IS NOT NULL
             AND sp.low IS NOT NULL
             AND sp.close IS NOT NULL
        ) AS completed_sessions
      FROM cohort
    )
    SELECT
      COUNT(*) AS total_snapshot_rows,
      COALESCE(SUM(CASE WHEN has_replay = 1 THEN 1 ELSE 0 END), 0) AS replay_rows,
      COALESCE(SUM(CASE WHEN has_replay = 0 AND completed_sessions >= 5 THEN 1 ELSE 0 END), 0) AS mature_missing_rows,
      COALESCE(SUM(CASE WHEN has_replay = 0 AND completed_sessions < 5 THEN 1 ELSE 0 END), 0) AS pending_maturity_rows
    FROM coverage
  `).bind(signalDate, signalDate, signalDate, maturityAsOfDate).first<{
    total_snapshot_rows?: number
    replay_rows?: number
    mature_missing_rows?: number
    pending_maturity_rows?: number
  }>()
  return {
    totalSnapshotRows: Number(row?.total_snapshot_rows ?? 0),
    replayRows: Number(row?.replay_rows ?? 0),
    matureMissingRows: Number(row?.mature_missing_rows ?? 0),
    pendingMaturityRows: Number(row?.pending_maturity_rows ?? 0),
  }
}

export async function loadFusionSnapshotSymbols(
  db: D1Database,
  signalDate: string,
  limit = 40,
  offset = 0,
): Promise<S12L0PassedSymbol[]> {
  const cappedLimit = Math.max(1, Math.min(160, Math.floor(limit)))
  const safeOffset = Math.max(0, Math.floor(offset))
  const { results } = await db.prepare(`
    WITH latest_snapshot AS (
      SELECT fs.*,
             ROW_NUMBER() OVER (
               PARTITION BY fs.symbol
               ORDER BY fs.generated_at DESC, fs.snapshot_source DESC
             ) AS snapshot_rank
        FROM allocator_ev_feature_snapshots fs
       WHERE fs.snapshot_date = ?
         AND json_extract(fs.score_components, '$.version') = 'score_v2'
         AND fs.snapshot_source = 'allocator_ev_asof_backfill_v2'
         AND fs.as_of_guard = '${ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD}'
    )
    SELECT fs.symbol,
           st.name,
           dr.score AS score_after,
           dr.rank,
           st.market,
           fs.market_segment,
           fs.alpha_context,
           fs.alpha_allocation
      FROM latest_snapshot fs
      LEFT JOIN daily_recommendations dr
        ON dr.date = fs.snapshot_date
       AND dr.symbol = fs.symbol
      LEFT JOIN stocks st
        ON st.symbol = fs.symbol
     WHERE fs.snapshot_rank = 1
     ORDER BY COALESCE(dr.rank, 999999), fs.symbol
     LIMIT ? OFFSET ?
  `).bind(signalDate, cappedLimit, safeOffset).all<S12L0PassedSymbol>()
  return (results ?? []).map((row) => ({
    symbol: String(row.symbol ?? '').trim(),
    name: row.name ?? null,
    score_after: row.score_after ?? null,
    rank: row.rank ?? null,
    market: row.market ?? null,
    market_segment: row.market_segment ?? null,
    alpha_context: row.alpha_context ?? null,
    alpha_allocation: row.alpha_allocation ?? null,
  })).filter((row) => row.symbol)
}

export async function resolveNextExecutableSessionDate(
  db: D1Database,
  symbol: string,
  signalDate: string,
): Promise<string | null> {
  const row = await db.prepare(`
    SELECT date(sp.date) AS execution_date
      FROM stock_prices sp
      JOIN stocks st ON st.id = sp.stock_id
     WHERE st.symbol = ?
       AND date(sp.date) > date(?)
       AND sp.open IS NOT NULL
       AND sp.high IS NOT NULL
       AND sp.low IS NOT NULL
       AND sp.close IS NOT NULL
     ORDER BY date(sp.date) ASC
     LIMIT 1
  `).bind(symbol, signalDate).first<{ execution_date?: string | null }>()
  const executionDate = String(row?.execution_date ?? '').trim().slice(0, 10)
  return executionDate || null
}

export async function loadReplayReadySignalDates(
  db: D1Database,
  asOfDate: string,
  limit = 5,
): Promise<string[]> {
  const cappedLimit = Math.max(1, Math.min(20, Math.floor(limit)))
  const { results } = await db.prepare(`
    SELECT fs.snapshot_date AS signal_date
      FROM allocator_ev_feature_snapshots fs
     WHERE date(fs.snapshot_date) < date(?)
       AND fs.snapshot_source = 'allocator_ev_asof_backfill_v2'
       AND fs.as_of_guard = '${ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD}'
       AND json_extract(fs.score_components, '$.version') = 'score_v2'
       AND EXISTS (
         SELECT 1
           FROM stock_prices sp
           JOIN stocks st ON st.id = sp.stock_id
          WHERE st.symbol = fs.symbol
            AND date(sp.date) > date(fs.snapshot_date)
            AND date(sp.date) <= date(?)
          GROUP BY st.symbol
         HAVING COUNT(DISTINCT date(sp.date)) >= 5
       )
       AND NOT EXISTS (
         SELECT 1
           FROM s12_replay_trade_outcomes replay
          WHERE replay.signal_date = fs.snapshot_date
            AND replay.symbol = fs.symbol
            AND replay.source = 's12_multisession_structure_replay_v3'
       )
     GROUP BY fs.snapshot_date
     ORDER BY fs.snapshot_date DESC
     LIMIT ?
  `).bind(asOfDate, asOfDate, cappedLimit).all<{ signal_date?: string | null }>()
  return (results ?? [])
    .map((row) => String(row.signal_date ?? '').trim().slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
}

const M15_MS = 15 * 60_000
const TW_OFFSET_MS = 8 * 60 * 60_000

function twDateKey(startMs: number): string {
  return new Date(startMs + TW_OFFSET_MS).toISOString().slice(0, 10)
}

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function round(value: number | null, digits = 10): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function alphaBucketFromContext(context: Record<string, unknown> | null, allocation: Record<string, unknown> | null): string | null {
  const raw = context?.edge_bucket ?? context?.bucket ?? allocation?.edge_bucket ?? allocation?.bucket ?? allocation?.alpha_bucket
  const text = String(raw ?? '').trim()
  return text || null
}

function alphaReplayMetadata(input: S12ReplayInput): Pick<
  S12ReplayOutcome,
  'market' | 'market_segment' | 'alpha_bucket' | 'alpha_context' | 'alpha_allocation'
> {
  const alphaContext = parseJsonRecord(input.alphaContext)
  const alphaAllocation = parseJsonRecord(input.alphaAllocation)
  return {
    market: String(input.market ?? '').trim() || null,
    market_segment: String(input.marketSegment ?? '').trim() || null,
    alpha_bucket: String(input.alphaBucket ?? alphaBucketFromContext(alphaContext, alphaAllocation) ?? '').trim() || null,
    alpha_context: alphaContext,
    alpha_allocation: alphaAllocation,
  }
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
    fallbackDailyBars: input.fallbackDailyBars ?? [],
    nowMs,
    policy: input.policy,
    h4ReferenceDate: input.h4ReferenceDate,
    h4ReferenceClose: input.h4ReferenceClose,
    barDiagnostics: input.replayDiagnostics,
  })
}

function isSetupValidState(state: string | null | undefined): boolean {
  return [
    'waiting_sweep',
    'waiting_choch',
    'waiting_bos',
    'waiting_retest',
    'waiting_reaction',
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
    schema_version: 's12-replay-trade-outcome-v3',
    symbol: input.symbol,
    signal_date: input.signalDate ?? input.tradeDate,
    trade_date: input.tradeDate,
    status,
    sample_eligible: false,
    source: 's12_multisession_structure_replay_v3',
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
    ...alphaReplayMetadata(input),
    replay_diagnostics: {
      ...(input.replayDiagnostics ?? {}),
      replay_engine_signature: S12_REPLAY_ENGINE_SIGNATURE,
      target_price_domain_contract: S12_REPLAY_TARGET_PRICE_DOMAIN_CONTRACT,
    },
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

interface S12ReplayTargetLadder {
  targets: number[]
  rejectedOutsideFiveSessionPriceDomain: number
}

function targetLadder(assessment: S12IntradayAssessment, calibration?: S12TwExitCalibration | null): S12ReplayTargetLadder {
  const entry = finitePositive(assessment.execution.entryPrice)
  const raw = [
    assessment.exitPlan.tp1.source === '15m_previous_high'
      ? null
      : finitePositive(assessment.execution.target1) ?? finitePositive(assessment.exitPlan.tp1.price),
    entry != null && calibration?.tp1MfeQuantile
      ? entry * (1 + calibration.tp1MfeQuantile)
      : null,
    finitePositive(assessment.execution.target2) ?? finitePositive(assessment.exitPlan.mainExit.price),
    entry != null && calibration?.tp2MfeQuantile
      ? entry * (1 + calibration.tp2MfeQuantile)
      : null,
    finitePositive(assessment.execution.target3) ?? finitePositive(assessment.exitPlan.tp3.price),
  ]
  const out: number[] = []
  let rejectedOutsideFiveSessionPriceDomain = 0
  const fiveSessionUpperBound = entry == null ? null : entry * S12_REPLAY_FIVE_SESSION_UPPER_MULTIPLIER
  for (const target of raw) {
    const normalized = target == null ? null : normalizeTwEquityTargetPrice(target)
    if (entry != null && normalized != null && fiveSessionUpperBound != null && normalized > fiveSessionUpperBound) {
      rejectedOutsideFiveSessionPriceDomain += 1
      continue
    }
    if (entry != null && normalized != null && normalized > entry && !out.some((x) => Math.abs(x - normalized) < 0.000001)) {
      out.push(normalized)
    }
  }
  return { targets: out, rejectedOutsideFiveSessionPriceDomain }
}

export function simulateS12ReplayTradeOutcome(input: S12ReplayInput, options: S12ReplayOptions = {}): S12ReplayOutcome {
  const bars = normalizeBars(input.baseBars)
  if (bars.length === 0) return emptyOutcome(input, 'skipped', 'missing_intraday_bars')

  const entrySessionBars = bars.filter((bar) => twDateKey(bar.startMs) === input.tradeDate)
  if (entrySessionBars.length === 0) return emptyOutcome(input, 'skipped', 'missing_entry_session_bars')

  const provider = options.assessmentProvider ?? defaultAssessmentProvider(input)
  const assessment = findEntryAssessment(input, entrySessionBars, provider, options.entryAssessment)
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
  const maxExitBars = options.maxExitBars == null
    ? bars.length
    : Math.max(1, Math.floor(options.maxExitBars))
  const futureBars = bars.slice(entryIndex + 1, entryIndex + 1 + maxExitBars)
  if (futureBars.length === 0) return emptyOutcome(input, 'skipped', 'missing_post_entry_bars', assessment)

  const targetResult = targetLadder(assessment, input.exitCalibration)
  const targets = targetResult.targets
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
      const stopFill = bar.open < activeStop ? bar.open : activeStop
      realized += remaining * ((stopFill - entry) / entry)
      remaining = 0
      exitPrice = stopFill
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
    const refreshedStructureStop = finitePositive(defense.exitPlan.trailingStop.initial)
      ?? finitePositive(defense.execution.stopLoss)
    if (refreshedStructureStop != null && refreshedStructureStop > activeStop && refreshedStructureStop < bar.close) {
      activeStop = refreshedStructureStop
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
    schema_version: 's12-replay-trade-outcome-v3',
    symbol: input.symbol,
    signal_date: input.signalDate ?? input.tradeDate,
    trade_date: input.tradeDate,
    status: 'executed',
    sample_eligible: true,
    source: 's12_multisession_structure_replay_v3',
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
    ...alphaReplayMetadata(input),
    replay_diagnostics: {
      ...(input.replayDiagnostics ?? {}),
      replay_engine_signature: S12_REPLAY_ENGINE_SIGNATURE,
      entry_policy_signature: assessment.state,
      exit_calibration_signature: String(input.replayDiagnostics?.calibration_artifact_id ?? 'uncalibrated'),
      replay_cohort_signature: [
        S12_REPLAY_ENGINE_SIGNATURE,
        `entry=${assessment.state}`,
        `calibration=${String(input.replayDiagnostics?.calibration_artifact_id ?? 'uncalibrated')}`,
      ].join('|'),
      target_price_domain_contract: S12_REPLAY_TARGET_PRICE_DOMAIN_CONTRACT,
      targets_rejected_outside_five_session_price_domain: targetResult.rejectedOutsideFiveSessionPriceDomain,
    },
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
    SELECT sfi.symbol,
           sfi.name,
           sfi.score_after,
           sfi.rank,
           sfi.evidence,
           st.market,
           dr.market_segment,
           dr.alpha_context,
           dr.alpha_allocation
      FROM screener_funnel_items sfi
      LEFT JOIN daily_recommendations dr
        ON dr.date = sfi.date
       AND dr.symbol = sfi.symbol
      LEFT JOIN stocks st
        ON st.symbol = sfi.symbol
     WHERE sfi.run_id = ?
       AND sfi.date = ?
       AND sfi.stage = 'universe'
       AND sfi.decision = 'pass'
     ORDER BY COALESCE(sfi.rank, 999999), sfi.symbol
  `).bind(run.run_id, tradeDate).all<S12L0PassedSymbol>()
  return (results ?? []).map((row) => ({
    symbol: String(row.symbol ?? '').trim(),
    name: row.name ?? null,
    score_after: row.score_after ?? null,
    rank: row.rank ?? null,
    evidence: row.evidence ?? null,
    market: row.market ?? null,
    market_segment: row.market_segment ?? null,
    alpha_context: row.alpha_context ?? null,
    alpha_allocation: row.alpha_allocation ?? null,
  })).filter((row) => row.symbol)
}

export async function loadSignedEligibleRepairSymbolsByHistoricalDate(
  db: D1Database,
  signalDate: string,
): Promise<S12L0PassedSymbol[]> {
  const { results } = await db.prepare(`
    SELECT DISTINCT legacy.symbol
      FROM s12_replay_trade_outcomes legacy
     WHERE legacy.signal_date = ?
       AND (
         legacy.sample_eligible = 1
         OR json_extract(legacy.detail_json, '$.lineage_validation.previous_sample_eligible') = 1
       )
       AND (
         COALESCE(json_extract(legacy.detail_json, '$.replay_diagnostics.replay_engine_signature'), '') != ?
         OR COALESCE(json_extract(legacy.detail_json, '$.replay_diagnostics.entry_policy_signature'), '') = ''
         OR COALESCE(json_extract(legacy.detail_json, '$.replay_diagnostics.exit_calibration_signature'), '') = ''
         OR COALESCE(json_extract(legacy.detail_json, '$.replay_diagnostics.replay_cohort_signature'), '') = ''
       )
       AND NOT EXISTS (
         SELECT 1
           FROM s12_replay_trade_outcomes current
          WHERE current.signal_date = legacy.signal_date
            AND current.symbol = legacy.symbol
            AND current.sample_eligible = 1
            AND json_extract(current.detail_json, '$.replay_diagnostics.replay_engine_signature') = ?
            AND COALESCE(json_extract(current.detail_json, '$.replay_diagnostics.entry_policy_signature'), '') != ''
            AND COALESCE(json_extract(current.detail_json, '$.replay_diagnostics.exit_calibration_signature'), '') != ''
            AND json_extract(current.detail_json, '$.replay_diagnostics.replay_cohort_signature') = (
              ? || '|entry=' || lower(json_extract(current.detail_json, '$.replay_diagnostics.entry_policy_signature'))
              || '|calibration=' || json_extract(current.detail_json, '$.replay_diagnostics.exit_calibration_signature')
            )
       )
     ORDER BY legacy.symbol
  `).bind(
    signalDate,
    S12_REPLAY_ENGINE_SIGNATURE,
    S12_REPLAY_ENGINE_SIGNATURE,
    S12_REPLAY_ENGINE_SIGNATURE,
  ).all<{ symbol: string }>()
  const pending = new Set((results ?? []).map((row) => String(row.symbol ?? '').trim()).filter(Boolean))
  if (pending.size === 0) return []
  const l0 = await loadL0PassedSymbolsByHistoricalDate(db, signalDate)
  return l0.filter((row) => pending.has(row.symbol))
}

export function s12ReplayEligibleLineageBlockers(outcome: S12ReplayOutcome): string[] {
  if (!outcome.sample_eligible) return []
  const blockers: string[] = []
  const diagnostics = outcome.replay_diagnostics ?? {}
  const entryPolicy = String(diagnostics.entry_policy_signature ?? '').trim().toLowerCase()
  const calibration = String(diagnostics.exit_calibration_signature ?? '').trim()
  const cohort = String(diagnostics.replay_cohort_signature ?? '').trim()
  const expectedCohort = [
    S12_REPLAY_ENGINE_SIGNATURE,
    `entry=${entryPolicy}`,
    `calibration=${calibration}`,
  ].join('|')
  if (outcome.schema_version !== 's12-replay-trade-outcome-v3') blockers.push('schema_version')
  if (outcome.source !== 's12_multisession_structure_replay_v3') blockers.push('source')
  if (outcome.status !== 'executed') blockers.push('status')
  if (!Number.isFinite(outcome.pnl_pct)) blockers.push('pnl_pct')
  if (String(diagnostics.replay_engine_signature ?? '').trim() !== S12_REPLAY_ENGINE_SIGNATURE) blockers.push('replay_engine_signature')
  if (!entryPolicy) blockers.push('entry_policy_signature')
  if (!calibration) blockers.push('exit_calibration_signature')
  if (!cohort || cohort !== expectedCohort) blockers.push('replay_cohort_signature')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(diagnostics.outcome_known_date ?? '').slice(0, 10))) blockers.push('outcome_known_date')
  return blockers
}

export async function persistS12ReplayOutcome(
  db: D1Database,
  outcome: S12ReplayOutcome,
): Promise<void> {
  const lineageBlockers = s12ReplayEligibleLineageBlockers(outcome)
  if (lineageBlockers.length > 0) {
    throw new Error(`s12_replay_eligible_lineage_invalid:${outcome.symbol}:${outcome.signal_date}:${lineageBlockers.join('|')}`)
  }
  const rawSetupId = outcome.setup_id ?? `${outcome.symbol}:${outcome.trade_date}:${outcome.status_reason}`
  const setupId = `${outcome.signal_date}:${rawSetupId}`
  await db.prepare(`
    INSERT INTO s12_replay_trade_outcomes (
      symbol, market, signal_date, trade_date, assessment_state, setup_id,
      entry_ms, exit_ms, entry_price, stop_price,
      target1_price, target2_price, target3_price, exit_price,
      pnl_pct, trade_pnl_r, max_favorable_pct, max_adverse_pct,
      bars_to_exit, exit_reason, sample_eligible, source, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, signal_date, setup_id) WHERE signal_date IS NOT NULL DO UPDATE SET
      market=excluded.market,
      trade_date=excluded.trade_date,
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
    outcome.market,
    outcome.signal_date,
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
  signalDate: string,
  options: S12HistoricalReplayRunOptions = {},
): Promise<S12HistoricalReplayRunSummary> {
  const leaseRunId = `s12-replay:${signalDate}:${crypto.randomUUID()}`
  const leaseAcquired = options.loadBars
    ? false
    : await acquireS12ResearchLease(env.DB, leaseRunId, signalDate)
  if (!options.loadBars && !leaseAcquired) {
    throw new Error(`s12_research_lease_busy:${signalDate}`)
  }
  try {
  const l0 = options.symbols ?? await loadL0PassedSymbolsByHistoricalDate(env.DB, signalDate)
  const requestedLimit = options.limit ?? (l0.length || 1)
  const limit = Math.max(1, Math.min(5000, Math.floor(Number(requestedLimit))))
  const offset = Math.max(0, Math.floor(Number(options.offset ?? 0)))
  const selected = l0.slice(offset, offset + limit)
  const outcomes: S12ReplayOutcome[] = []
  const calibrationArtifacts = await listApprovedS12TwCalibrationArtifacts(env.DB, { includeSuperseded: true }).catch(() => [])
  let persisted = 0
  let attempted = 0
  let unresolvedExecutionDates = 0
  let terminalDataSourceReason: string | null = null
  const executionDates = new Set<string>()
  for (const row of selected) {
    attempted += 1
    const executionDate = await (
      options.resolveExecutionDate
        ? options.resolveExecutionDate(row.symbol, signalDate)
        : resolveNextExecutableSessionDate(env.DB, row.symbol, signalDate)
    )
    if (!executionDate) {
      unresolvedExecutionDates += 1
      continue
    }
    executionDates.add(executionDate)
    const loadBars = options.loadBars ?? (async (symbol: string, date: string) => {
      const loaded = await loadS12HistoricalReplayLifecycleBars(
        env,
        symbol,
        date,
        5,
        options.maturityAsOfDate,
      )
      return {
        bars: loaded.bars,
        fallback15mBars: loaded.fallback15mBars,
        fallback1hBars: loaded.fallback1hBars,
        fallback4hBars: loaded.fallback4hBars,
        fallbackDailyBars: loaded.fallbackDailyBars,
        h4ReferenceDate: loaded.diagnostics.previous_daily_context_date ?? null,
        h4ReferenceClose: Number(loaded.diagnostics.previous_daily_raw_close ?? 0) || null,
        diagnostics: loaded.diagnostics,
        horizonComplete: Number(loaded.diagnostics.lifecycle_session_count ?? 0) >= 5,
      }
    })
    const loaded = await loadBars(row.symbol, executionDate)
    terminalDataSourceReason = s12ResearchTerminalDataSourceReason(loaded.diagnostics as any)
    if (loaded.horizonComplete === false) {
      unresolvedExecutionDates += 1
      if (terminalDataSourceReason) break
      continue
    }
    const alphaContext = parseJsonRecord(row.alpha_context)
    const alphaAllocation = parseJsonRecord(row.alpha_allocation)
    const alphaBucket = alphaBucketFromContext(alphaContext, alphaAllocation)
    const calibration = resolveS12TwCalibrationArtifact(calibrationArtifacts, {
      marketSegment: row.market_segment ?? 'UNKNOWN',
      alphaBucket,
      asOfDate: signalDate,
    })
    const lifecycleSessionDates = String(loaded.diagnostics?.lifecycle_session_dates ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    const outcomeKnownDate = lifecycleSessionDates[lifecycleSessionDates.length - 1]
      ?? options.maturityAsOfDate
      ?? executionDate
    const outcome = simulateS12ReplayTradeOutcome({
      symbol: row.symbol,
      signalDate,
      tradeDate: executionDate,
      baseBars: loaded.bars,
      fallback15mBars: loaded.fallback15mBars,
      fallback1hBars: loaded.fallback1hBars,
      fallback4hBars: loaded.fallback4hBars,
      fallbackDailyBars: loaded.fallbackDailyBars,
      h4ReferenceDate: loaded.h4ReferenceDate,
      h4ReferenceClose: loaded.h4ReferenceClose,
      policy: applyS12TwCalibrationArtifact(undefined, calibration),
      exitCalibration: calibration?.exit ?? null,
      marketSegment: row.market_segment ?? null,
      market: row.market ?? null,
      alphaBucket,
      alphaContext,
      alphaAllocation,
      replayDiagnostics: {
        ...(loaded.diagnostics ?? {}),
        signal_date: signalDate,
        execution_date: executionDate,
        execution_date_contract: 'next_stock_specific_session_after_signal',
        exit_horizon_contract: 'up_to_five_stock_specific_sessions_after_entry',
        outcome_known_date: outcomeKnownDate,
        outcome_known_at_contract: 'fifth_stock_specific_session_available',
        calibration_artifact_id: calibration?.artifactId ?? null,
        calibration_scope: calibration?.scope ?? null,
      },
    })
    outcomes.push(outcome)
    if (options.persist !== false) {
      await persistS12ReplayOutcome(env.DB, outcome)
      persisted += 1
    }
  }
  return {
    schema_version: 's12-historical-replay-run-summary-v3',
    signal_date: signalDate,
    execution_dates: [...executionDates].sort(),
    unresolved_execution_dates: unresolvedExecutionDates,
    l0_symbols: l0.length,
    attempted,
    executed: outcomes.filter((outcome) => outcome.status === 'executed').length,
    setup_only: outcomes.filter((outcome) => outcome.status === 'setup_only').length,
    skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    persisted,
    terminal_data_source_reason: terminalDataSourceReason,
    outcomes,
  }
  } finally {
    if (leaseAcquired) await releaseS12ResearchLease(env.DB, leaseRunId)
  }
}
