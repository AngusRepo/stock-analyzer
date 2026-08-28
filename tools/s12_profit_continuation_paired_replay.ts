import crypto from 'node:crypto'
import fs from 'node:fs'

import {
  simulateS12ProfitContinuationPair,
  type S12ReplayInput,
} from '../worker/src/lib/s12ReplayTradeOutcome'
import {
  type S12Bar,
  type S12IntradayAssessment,
} from '../worker/src/lib/s12IntradayStructure'

type JsonRecord = Record<string, unknown>

type ReplayFixture = {
  stored: JsonRecord
  detail: JsonRecord
  bars: S12Bar[]
  fallback15mBars?: S12Bar[]
  fallback1hBars?: S12Bar[]
  fallback4hBars?: S12Bar[]
  fallbackDailyBars?: S12Bar[]
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function text(value: unknown): string | null {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function checksum(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex')
}

function entryAssessment(fixture: ReplayFixture): S12IntradayAssessment {
  const stored = fixture.stored
  const detail = fixture.detail
  const entry = finite(detail.entry_price ?? stored.entry_price)
  const stop = finite(detail.stop_price ?? stored.stop_price)
  const target1 = finite(detail.target1_price)
  const target2 = finite(detail.target2_price)
  const target3 = finite(detail.target3_price)
  const entryMs = finite(detail.entry_ms ?? stored.entry_ms)
  if (entry == null || stop == null || entryMs == null) {
    throw new Error('persisted_entry_identity_missing')
  }
  const assessmentState = text(detail.assessment_state) ?? 'reaction_ready'
  const ready = detail.assessment_ready == null ? true : Boolean(detail.assessment_ready)
  return {
    version: 's12_intraday_structure_v1',
    symbol: text(stored.symbol) ?? 'UNKNOWN',
    direction: 'long',
    state: assessmentState as S12IntradayAssessment['state'],
    ready,
    reason: text(detail.assessment_reason) ?? 'persisted_s12_replay_entry',
    detail: text(detail.assessment_detail) ?? 'source=persisted_s12_replay_entry',
    setupId: text(detail.setup_id),
    completedBars: (detail.assessment_completed_bars ?? {}) as S12IntradayAssessment['completedBars'],
    sessionContextSource: 'current_session_60m',
    h4Source: 'current_session',
    h4ReferenceDate: null,
    h4ReferenceClose: null,
    barDiagnostics: (detail.assessment_bar_diagnostics ?? {}) as Record<string, unknown>,
    coverage: 'full',
    bias4h: { direction: 'long', confidence: 'confirmed', channelAlign: true },
    bias1h: { direction: 'long', confidence: 'confirmed', channelAlign: true },
    demandZone1h: null,
    supplyZone1h: null,
    bearishDefense: {
      state: 'no_supply_zone',
      ready: false,
      action: 'none',
      reason: 'persisted_entry_snapshot',
      detail: '',
      supplyZone1h: null,
      sequence: {},
    },
    defensiveAction: 'none',
    quality: {} as S12IntradayAssessment['quality'],
    exitPlan: {
      mode: 'structure_first_trailing_v1',
      tp1: { price: target1, source: 'persisted_replay_target', action: 'partial_take_profit' },
      mainExit: {
        price: target2,
        zoneLow: null,
        zoneHigh: null,
        source: 'persisted_replay_target',
        action: 'main_take_profit',
      },
      tp3: { price: target3, source: 'persisted_replay_target', action: 'extended_take_profit' },
      tp4: { price: null, source: 'unavailable', action: 'extended_take_profit' },
      manualTp: { price: null, source: 'unavailable', action: 'manual_take_profit' },
      trailingStop: {
        initial: stop,
        method: 'persisted_replay_structure_stop',
        source: 'persisted_replay_outcome',
        activation: 'after_tp1_or_reverse_choch',
      },
      reverseWarning: { state: null, action: 'none', source: 'bearish_defense_sidecar' },
    },
    sequence: {
      ...((detail.assessment_sequence ?? {}) as S12IntradayAssessment['sequence']),
      reactionMs: entryMs,
    },
    execution: {
      entryPrice: entry,
      chaseCeiling: entry,
      stopLoss: stop,
      target1,
      target2,
      target3,
      target4: null,
      atr15m: null,
      rMultiple: null,
      ...((detail.assessment_execution ?? {}) as S12IntradayAssessment['execution']),
      entryPrice: entry,
      stopLoss: stop,
      target1,
      target2,
      target3,
    },
    maturity: (detail.assessment_maturity ?? {
      takeoverEligible: true,
      takeoverRole: 'long_entry',
      tier: 'full_reaction_ready',
      riskMode: 'full_size_reaction',
      policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
      blocker: assessmentState,
      stage: 'ready',
    }) as S12IntradayAssessment['maturity'],
  }
}

function near(left: unknown, right: unknown, tolerance: number): boolean {
  const a = finite(left)
  const b = finite(right)
  return a != null && b != null && Math.abs(a - b) <= tolerance
}

function evaluateFixture(fixture: ReplayFixture): JsonRecord {
  const stored = fixture.stored
  const detail = fixture.detail
  const assessment = entryAssessment(fixture)
  const input: S12ReplayInput = {
    symbol: text(stored.symbol) ?? 'UNKNOWN',
    signalDate: text(stored.signal_date) ?? undefined,
    tradeDate: text(stored.trade_date) ?? '',
    baseBars: fixture.bars,
    fallback15mBars: fixture.fallback15mBars ?? [],
    fallback1hBars: fixture.fallback1hBars ?? [],
    fallback4hBars: fixture.fallback4hBars ?? [],
    fallbackDailyBars: fixture.fallbackDailyBars ?? [],
    market: text(stored.market),
    marketSegment: text(detail.market_segment),
    alphaBucket: text(detail.alpha_bucket),
    replayDiagnostics: (detail.replay_diagnostics ?? {}) as JsonRecord,
  }
  const pair = simulateS12ProfitContinuationPair(input, {
    entryAssessment: assessment,
    captureDecisionPath: true,
  })
  const parityFields = {
    entry_price: near(pair.incumbent.entry_price, stored.entry_price, 1e-6),
    stop_price: near(pair.incumbent.stop_price, stored.stop_price, 1e-6),
    exit_price: near(pair.incumbent.exit_price, stored.exit_price, 1e-6),
    pnl_pct: near(pair.incumbent.pnl_pct, stored.pnl_pct, 1e-9),
    exit_ms: Number(pair.incumbent.exit_ms ?? 0) === Number(stored.exit_ms ?? 0),
    exit_reason: pair.incumbent.exit_reason === text(stored.exit_reason),
  }
  const triggerMs = finite(pair.candidate.replay_diagnostics?.profit_continuation_trigger_ms)
  const deadlineMs = finite(pair.candidate.replay_diagnostics?.profit_continuation_deadline_ms)
  const path = pair.candidate.decision_path ?? []
  const twDate = (epochMs: number | null): string | null => epochMs == null
    ? null
    : new Date(epochMs + 8 * 60 * 60_000).toISOString().slice(0, 10)
  const candidateExitDate = twDate(finite(pair.candidate.exit_ms))
  const triggerDate = twDate(triggerMs)
  return {
    id: stored.id,
    symbol: stored.symbol,
    market: stored.market,
    market_segment: detail.market_segment ?? null,
    alpha_bucket: detail.alpha_bucket ?? null,
    signal_date: stored.signal_date,
    trade_date: stored.trade_date,
    stored_exit_reason: stored.exit_reason,
    stored_pnl_pct: stored.pnl_pct,
    incumbent_exit_reason: pair.incumbent.exit_reason,
    incumbent_pnl_pct: pair.incumbent.pnl_pct,
    candidate_exit_reason: pair.candidate.exit_reason,
    candidate_pnl_pct: pair.candidate.pnl_pct,
    candidate_mfe_pct: pair.candidate.mfe_pct,
    candidate_mae_pct: pair.candidate.mae_pct,
    eligible: pair.eligible,
    gross_delta_pct: pair.gross_delta_pct,
    cost_net_delta_pct: pair.cost_net_delta_pct,
    incremental_transaction_cost_bps: pair.incremental_transaction_cost_bps,
    incumbent_parity: {
      exact: Object.values(parityFields).every(Boolean),
      fields: parityFields,
    },
    continuation_trigger_ms: triggerMs,
    continuation_deadline_ms: deadlineMs,
    candidate_exit_ms: pair.candidate.exit_ms,
    no_overnight: triggerDate == null || candidateExitDate === triggerDate,
    deadline_respected: deadlineMs == null || Number(pair.candidate.exit_ms ?? 0) <= deadlineMs,
    decision_path_rows: path.length,
    decision_path_checksum: checksum(path),
    safety_exit: String(pair.candidate.exit_reason ?? '').includes('structure_stop') ||
      String(pair.candidate.exit_reason ?? '').includes('bearish_defense'),
  }
}

function main(): void {
  const inputPath = process.argv[2]
  const outputPath = process.argv[3]
  if (!inputPath || !outputPath) throw new Error('usage: tsx s12_profit_continuation_paired_replay.ts INPUT OUTPUT')
  const fixtures = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as ReplayFixture[]
  const rows = fixtures.map((fixture) => {
    try {
      return evaluateFixture(fixture)
    } catch (error) {
      return {
        id: fixture.stored.id,
        symbol: fixture.stored.symbol,
        signal_date: fixture.stored.signal_date,
        trade_date: fixture.stored.trade_date,
        eligible: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
  const receipt = {
    schema_version: 's12-profit-continuation-local-replay-rows-v1',
    production_effect: false,
    rank_or_top_k_used: false,
    rows,
  }
  fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2), 'utf8')
  process.stdout.write(JSON.stringify({
    rows: rows.length,
    errors: rows.filter((row) => row.error).length,
    exact_parity: rows.filter((row) => (row.incumbent_parity as JsonRecord | undefined)?.exact === true).length,
    eligible: rows.filter((row) => row.eligible === true).length,
  }) + '\n')
}

main()
