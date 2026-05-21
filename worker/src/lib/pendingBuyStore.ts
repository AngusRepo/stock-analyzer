import type { Bindings } from '../types'
import {
  applyPendingBuyExecutionEvents,
  applyPendingBuySlaExpiry,
  type PendingBuyExecutionEvent,
  type PendingBuyExecutionStatus,
} from './pendingBuyExecutionState'
import { recordPaperExecutionEvents } from './paperExecutionEvents'

export type PendingBuyRunStatus =
  | 'ready'
  | 'empty'
  | 'halted'
  | 'error'
  | 'superseded'

export type PendingBuyDebateStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface PendingBuyDebateTurn {
  agent: string
  round?: number | null
  stance?: string | null
  summary: string
  conviction?: number | null
}

export interface PendingBuy {
  symbol: string
  name: string
  signal: string
  confidence: number
  ml_entry_price: number
  ml_stop_loss: number | null
  ml_target1: number | null
  ml_target2: number | null
  reason: string
  watch_points: string[]
  debate_verdict: string
  risk_pct: number
  kelly_pct: number | null
  chip_score: number | null
  tech_score: number | null
  ml_score: number | null
  score: number | null
  source?: string | null
  debate_status?: PendingBuyDebateStatus
  execution_status?: PendingBuyExecutionStatus
  original_entry?: number | null
  retry_count?: number | null
  debate_agent_turns?: PendingBuyDebateTurn[]
}

interface PendingBuyRunRow {
  id: number
  trade_date: string
  source_reco_date: string | null
  status: PendingBuyRunStatus
  debate_status: PendingBuyDebateStatus
  candidate_count: number
  error_message: string | null
  created_at: string
  updated_at: string
}

interface PendingBuyItemRow {
  symbol: string
  name: string
  signal: string
  confidence: number
  ml_entry_price: number
  ml_stop_loss: number | null
  ml_target1: number | null
  ml_target2: number | null
  reason: string | null
  watch_points_json: string | null
  debate_verdict: string | null
  debate_status: PendingBuyDebateStatus | null
  execution_status: PendingBuyExecutionStatus | null
  risk_pct: number | null
  kelly_pct: number | null
  chip_score: number | null
  tech_score: number | null
  ml_score: number | null
  score: number | null
  source: string | null
  original_entry: number | null
  retry_count: number | null
}

interface PendingBuyCountRow {
  key: string | null
  count: number
}

export interface PendingBuySnapshot {
  date: string
  requested_date: string
  is_stale: boolean
  resolved_from: 'today' | 'fallback_recent' | 'empty'
  source: 'd1' | 'kv' | 'none'
  pendingBuys: PendingBuy[]
  meta?: Record<string, unknown>
}

export interface PendingBuyRunHistoryEntry {
  run_id: number
  trade_date: string
  source_reco_date: string | null
  status: PendingBuyRunStatus
  debate_status: PendingBuyDebateStatus
  candidate_count: number
  error_message: string | null
  created_at: string
  updated_at: string
  execution_counts: Record<string, number>
  debate_counts: Record<string, number>
  items: PendingBuy[]
}

export interface PendingBuyRunHistory {
  requested_date: string
  source: 'd1' | 'none'
  runs: PendingBuyRunHistoryEntry[]
}

interface ReplacePendingBuyStateParams {
  tradeDate: string
  sourceRecoDate?: string | null
  status: PendingBuyRunStatus
  debateStatus?: PendingBuyDebateStatus
  errorMessage?: string | null
  pendingBuys: PendingBuy[]
  kvPendingBuys?: PendingBuy[]
  meta?: Record<string, unknown>
}

const ACTIVE_RUN_STATUSES: PendingBuyRunStatus[] = ['ready', 'empty', 'halted', 'error']

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(String(error))
}

function toWatchPointsJson(points: string[] | null | undefined): string {
  return JSON.stringify(Array.isArray(points) ? points : [])
}

function fromWatchPointsJson(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : []
  } catch {
    return []
  }
}

function mapItemRow(row: PendingBuyItemRow): PendingBuy {
  return {
    symbol: row.symbol,
    name: row.name,
    signal: row.signal,
    confidence: Number(row.confidence ?? 0),
    ml_entry_price: Number(row.ml_entry_price ?? 0),
    ml_stop_loss: row.ml_stop_loss ?? null,
    ml_target1: row.ml_target1 ?? null,
    ml_target2: row.ml_target2 ?? null,
    reason: row.reason ?? '',
    watch_points: fromWatchPointsJson(row.watch_points_json),
    debate_verdict: row.debate_verdict ?? 'PENDING',
    debate_status: row.debate_status ?? 'pending',
    execution_status: row.execution_status ?? 'pending',
    risk_pct: Number(row.risk_pct ?? 0),
    kelly_pct: row.kelly_pct ?? null,
    chip_score: row.chip_score ?? null,
    tech_score: row.tech_score ?? null,
    ml_score: row.ml_score ?? null,
    score: row.score ?? null,
    source: row.source ?? null,
    original_entry: row.original_entry ?? null,
    retry_count: row.retry_count ?? null,
  }
}

function parseDebateEvidence(raw: string | null): PendingBuyDebateTurn {
  if (!raw) return { agent: 'Unknown', summary: '' }
  try {
    const parsed = JSON.parse(raw)
    return {
      agent: String(parsed.agent ?? 'Unknown'),
      round: parsed.round == null ? null : Number(parsed.round),
      stance: parsed.stance == null ? null : String(parsed.stance),
      summary: String(parsed.summary ?? ''),
      conviction: parsed.conviction == null ? null : Number(parsed.conviction),
    }
  } catch {
    return { agent: 'Unknown', summary: raw }
  }
}

async function loadDebateTurnsBySymbol(
  db: D1Database,
  tradeDate: string,
  symbols: string[],
): Promise<Map<string, PendingBuyDebateTurn[]>> {
  const out = new Map<string, PendingBuyDebateTurn[]>()
  const cleanSymbols = [...new Set(symbols.map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  if (!cleanSymbols.length) return out
  try {
    const placeholders = cleanSymbols.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT symbol, agent, round, stance, summary, evidence_json
         FROM pending_buy_debate_turns
        WHERE trade_date = ?
          AND symbol IN (${placeholders})
        ORDER BY symbol ASC, round ASC, id ASC`
    ).bind(tradeDate, ...cleanSymbols).all<{
      symbol: string
      agent: string | null
      round: number | null
      stance: string | null
      summary: string | null
      evidence_json: string | null
    }>()
    for (const row of results ?? []) {
      const turn = parseDebateEvidence(row.evidence_json)
      turn.agent = row.agent ?? turn.agent
      turn.round = row.round ?? turn.round ?? null
      turn.stance = row.stance ?? turn.stance ?? null
      turn.summary = row.summary ?? turn.summary
      const list = out.get(row.symbol) ?? []
      list.push(turn)
      out.set(row.symbol, list)
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error
  }
  return out
}

async function attachDebateTurns(
  db: D1Database,
  tradeDate: string,
  items: PendingBuy[],
): Promise<PendingBuy[]> {
  const bySymbol = await loadDebateTurnsBySymbol(db, tradeDate, items.map((item) => item.symbol))
  return items.map((item) => ({
    ...item,
    debate_agent_turns: bySymbol.get(item.symbol) ?? [],
  }))
}

function rowsToCounts(rows: PendingBuyCountRow[] | undefined): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows ?? []) {
    const key = row.key ?? 'unknown'
    counts[key] = Number(row.count ?? 0)
  }
  return counts
}

async function readKvSnapshot(
  env: Bindings,
  requestedDate: string,
  allowFallbackRecent: boolean,
): Promise<PendingBuySnapshot> {
  let raw = await env.KV.get(`paper:pending_buys:${requestedDate}`, 'json') as PendingBuy[] | null
  let resolvedDate = requestedDate
  let resolvedFrom: PendingBuySnapshot['resolved_from'] = 'today'
  if ((!raw || !Array.isArray(raw) || raw.length === 0) && allowFallbackRecent) {
    for (let d = 1; d <= 4; d++) {
      const prev = new Date(new Date(`${requestedDate}T00:00:00Z`).getTime() - d * 86400_000).toISOString().slice(0, 10)
      raw = await env.KV.get(`paper:pending_buys:${prev}`, 'json') as PendingBuy[] | null
      if (raw && Array.isArray(raw) && raw.length > 0) {
        resolvedDate = prev
        resolvedFrom = 'fallback_recent'
        break
      }
    }
  }
  if (!raw || !Array.isArray(raw) || raw.length === 0) resolvedFrom = 'empty'
  const meta = await env.KV.get(`paper:pending_buys_meta:${resolvedDate}`, 'json') as Record<string, unknown> | null
  return {
    date: resolvedDate,
    requested_date: requestedDate,
    is_stale: resolvedDate !== requestedDate,
    resolved_from: resolvedFrom,
    source: resolvedFrom === 'empty' ? 'none' : 'kv',
    pendingBuys: raw ?? [],
    meta: meta ?? undefined,
  }
}

async function syncKvSnapshot(
  env: Bindings,
  tradeDate: string,
  pendingBuys: PendingBuy[],
  meta?: Record<string, unknown>,
): Promise<void> {
  await env.KV.put(`paper:pending_buys:${tradeDate}`, JSON.stringify(pendingBuys), { expirationTtl: 86400 })
  if (!meta) return
  await env.KV.put(
    `paper:pending_buys_meta:${tradeDate}`,
    JSON.stringify({ updated_at: new Date().toISOString(), ...meta }),
    { expirationTtl: 86400 },
  )
}

async function recordPendingBuyAuditEvents(
  env: Bindings,
  tradeDate: string,
  source: string,
  pendingRunId: number | null,
  auditEvents: Array<Record<string, unknown>>,
): Promise<void> {
  if (auditEvents.length === 0) return
  await recordPaperExecutionEvents(env, auditEvents.map((event) => ({
    tradeDate,
    symbol: typeof event.symbol === 'string' ? event.symbol : null,
    eventType: 'pending_buy',
    status: typeof event.status === 'string' ? event.status : 'unknown',
    reason: typeof event.reason === 'string' ? event.reason : null,
    detail: event.detail ? { detail: event.detail } : null,
    pendingRunId,
    source,
  })))
}

function auditEventsFromMeta(meta?: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(meta?.execution_events)
    ? meta.execution_events as Array<Record<string, unknown>>
    : []
}

async function findRunForDate(db: D1Database, tradeDate: string): Promise<PendingBuyRunRow | null> {
  return await db.prepare(
    `SELECT id, trade_date, source_reco_date, status, debate_status, candidate_count, error_message, created_at, updated_at
       FROM pending_buy_runs
      WHERE trade_date = ? AND status != 'superseded'
      ORDER BY id DESC
      LIMIT 1`
  ).bind(tradeDate).first<PendingBuyRunRow>()
}

async function readD1Snapshot(
  env: Bindings,
  requestedDate: string,
  allowFallbackRecent: boolean,
): Promise<PendingBuySnapshot> {
  const dates = [requestedDate]
  if (allowFallbackRecent) {
    for (let d = 1; d <= 4; d++) {
      dates.push(new Date(new Date(`${requestedDate}T00:00:00Z`).getTime() - d * 86400_000).toISOString().slice(0, 10))
    }
  }

  let run: PendingBuyRunRow | null = null
  let resolvedDate = requestedDate
  for (const date of dates) {
    run = await findRunForDate(env.DB, date)
    if (run) {
      resolvedDate = date
      break
    }
  }
  if (!run) {
    return {
      date: requestedDate,
      requested_date: requestedDate,
      is_stale: false,
      resolved_from: 'empty',
      source: 'none',
      pendingBuys: [],
    }
  }

  const { results } = await env.DB.prepare(
    `SELECT symbol, name, signal, confidence, ml_entry_price, ml_stop_loss, ml_target1, ml_target2,
            reason, watch_points_json, debate_verdict, debate_status, execution_status, risk_pct,
            kelly_pct, chip_score, tech_score, ml_score, score, source, original_entry, retry_count
       FROM pending_buy_items
      WHERE run_id = ?
        AND COALESCE(execution_status, 'pending') NOT IN ('filled', 'skipped', 'cancelled', 'expired', 'rejected')
      ORDER BY score DESC, confidence DESC, symbol ASC`
  ).bind(run.id).all<PendingBuyItemRow>()
  const [executionCountRows, debateCountRows] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(execution_status, 'pending') AS key, COUNT(*) AS count
         FROM pending_buy_items
        WHERE run_id = ?
        GROUP BY COALESCE(execution_status, 'pending')`
    ).bind(run.id).all<PendingBuyCountRow>(),
    env.DB.prepare(
      `SELECT COALESCE(debate_status, 'pending') AS key, COUNT(*) AS count
         FROM pending_buy_items
        WHERE run_id = ?
        GROUP BY COALESCE(debate_status, 'pending')`
    ).bind(run.id).all<PendingBuyCountRow>(),
  ])

  const pendingBuys = await attachDebateTurns(env.DB, resolvedDate, (results ?? []).map(mapItemRow))

  return {
    date: resolvedDate,
    requested_date: requestedDate,
    is_stale: resolvedDate !== requestedDate,
    resolved_from: resolvedDate === requestedDate ? 'today' : 'fallback_recent',
    source: 'd1',
    pendingBuys,
    meta: {
      run_id: run.id,
      status: run.status,
      debate_status: run.debate_status,
      candidate_count: run.candidate_count,
      source_reco_date: run.source_reco_date,
      error_message: run.error_message ?? undefined,
      execution_counts: rowsToCounts(executionCountRows.results),
      debate_counts: rowsToCounts(debateCountRows.results),
      created_at: run.created_at,
      updated_at: run.updated_at,
    },
  }
}

export async function loadPendingBuySnapshot(
  env: Bindings,
  requestedDate: string,
  opts: { allowFallbackRecent?: boolean } = {},
): Promise<PendingBuySnapshot> {
  const allowFallbackRecent = opts.allowFallbackRecent ?? false
  try {
    return await readD1Snapshot(env, requestedDate, allowFallbackRecent)
  } catch (error) {
    if (!isMissingTableError(error)) throw error
    return await readKvSnapshot(env, requestedDate, allowFallbackRecent)
  }
}

export async function loadPendingBuyRunHistory(
  env: Bindings,
  requestedDate: string,
  opts: { limit?: number } = {},
): Promise<PendingBuyRunHistory> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 10))
  try {
    const { results: runs } = await env.DB.prepare(
      `SELECT id, trade_date, source_reco_date, status, debate_status, candidate_count, error_message, created_at, updated_at
         FROM pending_buy_runs
        WHERE trade_date <= ? AND status != 'superseded'
        ORDER BY trade_date DESC, id DESC
        LIMIT ?`
    ).bind(requestedDate, limit).all<PendingBuyRunRow>()
    const out: PendingBuyRunHistoryEntry[] = []
    for (const run of runs ?? []) {
      const [{ results: itemRows }, executionCountRows, debateCountRows] = await Promise.all([
        env.DB.prepare(
          `SELECT symbol, name, signal, confidence, ml_entry_price, ml_stop_loss, ml_target1, ml_target2,
                  reason, watch_points_json, debate_verdict, debate_status, execution_status, risk_pct,
                  kelly_pct, chip_score, tech_score, ml_score, score, source, original_entry, retry_count
             FROM pending_buy_items
            WHERE run_id = ?
            ORDER BY score DESC, confidence DESC, symbol ASC`
        ).bind(run.id).all<PendingBuyItemRow>(),
        env.DB.prepare(
          `SELECT COALESCE(execution_status, 'pending') AS key, COUNT(*) AS count
             FROM pending_buy_items
            WHERE run_id = ?
            GROUP BY COALESCE(execution_status, 'pending')`
        ).bind(run.id).all<PendingBuyCountRow>(),
        env.DB.prepare(
          `SELECT COALESCE(debate_status, 'pending') AS key, COUNT(*) AS count
             FROM pending_buy_items
            WHERE run_id = ?
            GROUP BY COALESCE(debate_status, 'pending')`
        ).bind(run.id).all<PendingBuyCountRow>(),
      ])
      const items = await attachDebateTurns(env.DB, run.trade_date, (itemRows ?? []).map(mapItemRow))
      out.push({
        run_id: run.id,
        trade_date: run.trade_date,
        source_reco_date: run.source_reco_date,
        status: run.status,
        debate_status: run.debate_status,
        candidate_count: run.candidate_count,
        error_message: run.error_message,
        created_at: run.created_at,
        updated_at: run.updated_at,
        execution_counts: rowsToCounts(executionCountRows.results),
        debate_counts: rowsToCounts(debateCountRows.results),
        items,
      })
    }
    return { requested_date: requestedDate, source: out.length ? 'd1' : 'none', runs: out }
  } catch (error) {
    if (!isMissingTableError(error)) throw error
    return { requested_date: requestedDate, source: 'none', runs: [] }
  }
}

export async function replacePendingBuyState(
  env: Bindings,
  params: ReplacePendingBuyStateParams,
): Promise<void> {
  const debateStatus = params.debateStatus ?? 'pending'
  const meta = {
    status: params.status,
    debate_status: debateStatus,
    source_reco_date: params.sourceRecoDate ?? undefined,
    error_message: params.errorMessage ?? undefined,
    ...(params.meta ?? {}),
  }
  try {
    await env.DB.prepare(
      `UPDATE pending_buy_runs
          SET status='superseded', updated_at=datetime('now')
        WHERE trade_date=? AND status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(',')})`
    ).bind(params.tradeDate, ...ACTIVE_RUN_STATUSES).run()

    const runRow = await env.DB.prepare(
      `INSERT INTO pending_buy_runs
        (trade_date, source_reco_date, status, debate_status, candidate_count, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       RETURNING id`
    ).bind(
      params.tradeDate,
      params.sourceRecoDate ?? null,
      params.status,
      debateStatus,
      params.pendingBuys.length,
      params.errorMessage ?? null,
    ).first<{ id: number }>()

    const runId = Number(runRow?.id ?? 0)
    if (!runId && params.pendingBuys.length > 0) {
      throw new Error(`pending_buy_runs insert did not return id for ${params.tradeDate}`)
    }
    if (runId > 0 && params.pendingBuys.length > 0) {
      for (const item of params.pendingBuys) {
        await env.DB.prepare(
          `INSERT INTO pending_buy_items
            (run_id, symbol, name, signal, confidence, ml_entry_price, ml_stop_loss, ml_target1, ml_target2,
             reason, watch_points_json, debate_verdict, debate_status, execution_status, risk_pct, kelly_pct,
             chip_score, tech_score, ml_score, score, source, original_entry, retry_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).bind(
          runId,
          item.symbol,
          item.name,
          item.signal,
          item.confidence,
          item.ml_entry_price,
          item.ml_stop_loss ?? null,
          item.ml_target1 ?? null,
          item.ml_target2 ?? null,
          item.reason ?? '',
          toWatchPointsJson(item.watch_points),
          item.debate_verdict ?? 'PENDING',
          item.debate_status ?? debateStatus,
          item.execution_status ?? 'pending',
          item.risk_pct ?? 0,
          item.kelly_pct ?? null,
          item.chip_score ?? null,
          item.tech_score ?? null,
          item.ml_score ?? null,
          item.score ?? null,
          item.source ?? 'morning_setup',
          item.original_entry ?? null,
          item.retry_count ?? 0,
        ).run()
      }

      const inserted = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM pending_buy_items WHERE run_id = ?',
      ).bind(runId).first<{ count: number }>()
      if (Number(inserted?.count ?? 0) !== params.pendingBuys.length) {
        throw new Error(
          `pending_buy_items insert mismatch for run ${runId}: expected ${params.pendingBuys.length}, got ${inserted?.count ?? 0}`,
        )
      }
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error
  }

  await syncKvSnapshot(env, params.tradeDate, params.kvPendingBuys ?? params.pendingBuys, meta)
}

export async function persistPendingBuyDebateTurns(
  env: Bindings,
  tradeDate: string,
  symbol: string,
  turns: PendingBuyDebateTurn[],
): Promise<void> {
  const cleanSymbol = String(symbol || '').trim()
  if (!cleanSymbol || !turns.length) return
  try {
    await env.DB.prepare(
      `DELETE FROM pending_buy_debate_turns
        WHERE trade_date = ? AND symbol = ?`
    ).bind(tradeDate, cleanSymbol).run()
    for (const turn of turns) {
      await env.DB.prepare(
        `INSERT INTO pending_buy_debate_turns
          (trade_date, symbol, agent, round, stance, summary, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(
        tradeDate,
        cleanSymbol,
        turn.agent,
        turn.round ?? null,
        turn.stance ?? null,
        turn.summary,
        JSON.stringify(turn),
      ).run()
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error
  }
}

export async function appendPendingBuy(
  env: Bindings,
  tradeDate: string,
  entry: PendingBuy,
  meta?: Record<string, unknown>,
): Promise<void> {
  const snapshot = await loadPendingBuySnapshot(env, tradeDate, { allowFallbackRecent: false })
  const existing = snapshot.pendingBuys.filter((item) => item.symbol !== entry.symbol)
  existing.push(entry)
  await replacePendingBuyState(env, {
    tradeDate,
    sourceRecoDate: typeof snapshot.meta?.source_reco_date === 'string' ? String(snapshot.meta?.source_reco_date) : tradeDate,
    status: 'ready',
    debateStatus: existing.some((item) => (item.debate_status ?? 'pending') === 'pending') ? 'pending' : 'completed',
    pendingBuys: existing,
    meta: {
      previous_source: snapshot.source,
      ...(meta ?? {}),
    },
  })
}

export async function persistPendingBuyActiveState(
  env: Bindings,
  tradeDate: string,
  remaining: PendingBuy[],
  meta?: Record<string, unknown>,
): Promise<void> {
  const snapshot = await loadPendingBuySnapshot(env, tradeDate, { allowFallbackRecent: false })
  const parsedRunId = Number(snapshot.meta?.run_id)
  const pendingRunId = Number.isFinite(parsedRunId) && parsedRunId > 0 ? parsedRunId : null
  await replacePendingBuyState(env, {
    tradeDate,
    sourceRecoDate: typeof snapshot.meta?.source_reco_date === 'string' ? String(snapshot.meta?.source_reco_date) : tradeDate,
    status: 'ready',
    debateStatus: remaining.some((item) => (item.debate_status ?? 'pending') === 'pending') ? 'pending' : 'completed',
    pendingBuys: remaining,
    meta: {
      previous_source: snapshot.source,
      ...(meta ?? {}),
    },
  })
  await recordPendingBuyAuditEvents(
    env,
    tradeDate,
    typeof meta?.stage === 'string' ? meta.stage : 'pending_buy',
    pendingRunId,
    auditEventsFromMeta(meta),
  )
}

export const markPendingBuysFilled = persistPendingBuyActiveState

export async function markPendingBuyExecutionEvents(
  env: Bindings,
  tradeDate: string,
  pendingBuys: PendingBuy[],
  events: PendingBuyExecutionEvent[],
  meta?: Record<string, unknown>,
): Promise<void> {
  if (events.length === 0) return
  const snapshot = await loadPendingBuySnapshot(env, tradeDate, { allowFallbackRecent: false })
  const transition = applyPendingBuyExecutionEvents(pendingBuys, events)
  const parsedRunId = Number(snapshot.meta?.run_id)
  const pendingRunId = Number.isFinite(parsedRunId) && parsedRunId > 0 ? parsedRunId : null
  const auditEvents = auditEventsFromMeta(meta)
  await replacePendingBuyState(env, {
    tradeDate,
    sourceRecoDate: typeof snapshot.meta?.source_reco_date === 'string' ? String(snapshot.meta?.source_reco_date) : tradeDate,
    status: 'ready',
    debateStatus: transition.activeItems.some((item) => (item as PendingBuy).debate_status === 'pending') ? 'pending' : 'completed',
    pendingBuys: transition.allItems as PendingBuy[],
    kvPendingBuys: transition.activeItems as PendingBuy[],
    meta: {
      previous_source: snapshot.source,
      execution_summary: transition.summary,
      ...(meta ?? {}),
    },
  })
  await recordPaperExecutionEvents(env, events.map((event) => {
    const auditEvent = auditEvents.find((candidate) =>
      candidate.symbol === event.symbol
      && candidate.status === event.status
      && candidate.reason === event.reason
    )
    return {
      tradeDate,
      symbol: event.symbol,
      eventType: 'pending_buy',
      status: event.status,
      reason: event.reason,
      detail: auditEvent?.detail ? { detail: auditEvent.detail } : null,
      pendingRunId,
      source: typeof meta?.stage === 'string' ? meta.stage : 'pending_buy',
    }
  }))
  const terminalEventKeys = new Set(events.map((event) => `${event.symbol}:${event.status}:${event.reason}`))
  await recordPendingBuyAuditEvents(
    env,
    tradeDate,
    typeof meta?.stage === 'string' ? meta.stage : 'pending_buy',
    pendingRunId,
    auditEvents.filter((event) => {
      const symbol = typeof event.symbol === 'string' ? event.symbol : ''
      const status = typeof event.status === 'string' ? event.status : ''
      const reason = typeof event.reason === 'string' ? event.reason : ''
      return !terminalEventKeys.has(`${symbol}:${status}:${reason}`)
    }),
  )
}

function previousDate(dateStr: string, offsetDays: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetDays * 86400_000)
    .toISOString()
    .slice(0, 10)
}

function normalizeDebateStatus(value: unknown): PendingBuyDebateStatus {
  return value === 'failed' || value === 'skipped' ? value : 'completed'
}

export async function expirePendingBuysForDate(
  env: Bindings,
  tradeDate: string,
  reason = 'stale_pending_buy_sla',
): Promise<number> {
  const snapshot = await loadPendingBuySnapshot(env, tradeDate, { allowFallbackRecent: false })
  if (snapshot.pendingBuys.length === 0) return 0

  const transition = applyPendingBuySlaExpiry(snapshot.pendingBuys, reason)
  if (!transition.changed) return 0

  await replacePendingBuyState(env, {
    tradeDate,
    sourceRecoDate: typeof snapshot.meta?.source_reco_date === 'string' ? String(snapshot.meta.source_reco_date) : tradeDate,
    status: 'ready',
    debateStatus: normalizeDebateStatus(snapshot.meta?.debate_status),
    pendingBuys: transition.allItems as PendingBuy[],
    kvPendingBuys: transition.activeItems as PendingBuy[],
    meta: {
      previous_source: snapshot.source,
      stage: 'sla_expiry',
      expiry_reason: reason,
      execution_summary: transition.summary,
    },
  })

  return transition.summary.expired
}

export async function expireRecentPendingBuys(
  env: Bindings,
  beforeDate: string,
  lookbackDays = 4,
): Promise<number> {
  let expired = 0
  for (let offset = 1; offset <= lookbackDays; offset += 1) {
    expired += await expirePendingBuysForDate(env, previousDate(beforeDate, offset), 'stale_previous_session')
  }
  return expired
}
