import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'

interface ExecutionPreviewRow {
  symbol: string
  kind: 's12' | 'or15' | 'allocator'
  status: string
  reason: string | null
  detail_json: string | null
  created_at: string
}

export interface PendingBuyExecutionPreview {
  entry_owner?: 's12' | 'or15_vwap_v1' | 'or15-5m-orl8-20-v1'
  or15?: {
    conditions?: Record<string, boolean | null>
    signal_high?: number | null
    signal_close?: number | null
    max_buy_price?: number | null
    quote_price?: number | null
    action: string
    reason: string
    or_high: number | null
    or_low: number | null
    vwap: number | null
    relative_return?: number | null
    ma60?: number | null
    vwap_basis?: string | null
    latest_bar_ms: number | null
    bar_source: string | null
    bar_error: string | null
    checked_at: string
  } | null
  s12: {
    state: string
    reason: string
    ready: boolean
    entry_price: number | null
    chase_ceiling: number | null
    checked_at: string
  } | null
  allocator: {
    action: string
    reason: string
    budget_cap: number | null
    target_value: number | null
    available_cash: number | null
    l5_status: string | null
    l5_reasons: string[]
    s12_hard_veto: boolean
    checked_at: string
  } | null
}

function finitePositive(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function finiteNonnegative(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function detailField(detail: string, key: string): string | null {
  const match = detail.match(new RegExp('(?:^|[;:])' + key + '=([^;]*)'))
  return match?.[1] ?? null
}

export function buildPendingBuyExecutionPreviews(rows: ExecutionPreviewRow[], entryOwner: 's12' | 'or15_vwap_v1' | 'or15-5m-orl8-20-v1' = 's12'): Map<string, PendingBuyExecutionPreview> {
  const previews = new Map<string, PendingBuyExecutionPreview>()
  for (const row of rows) {
    const preview = previews.get(row.symbol) ?? { entry_owner: entryOwner, or15: null, s12: null, allocator: null }
    try {
      const payload = JSON.parse(row.detail_json ?? '{}') as Record<string, any>
      if (row.kind === 'or15') {
        const signal = payload.signal ?? {}
        preview.or15 = {
          conditions: signal.conditions && typeof signal.conditions === 'object' ? Object.fromEntries(Object.entries(signal.conditions).map(([key, value]) => [key, typeof value === 'boolean' ? value : null])) : undefined,
          signal_high: finitePositive(signal.signalHigh), signal_close: finitePositive(signal.signalClose),
          max_buy_price: finitePositive(signal.maxBuyPrice), quote_price: finitePositive(signal.quotePrice),
          action: String(signal.action ?? row.status),
          reason: String(signal.reason ?? row.reason ?? ''),
          or_high: finitePositive(signal.orHigh),
          or_low: finitePositive(signal.orLow),
          vwap: finitePositive(signal.vwap),
          latest_bar_ms: finitePositive(signal.latestBarMs ?? signal.signalMs),
          relative_return: typeof signal.relativeReturn === "number" ? signal.relativeReturn : null,
          ma60: finitePositive(signal.ma60), vwap_basis: signal.vwapBasis ?? null,
          bar_source: typeof payload.bar_source === 'string' ? payload.bar_source : null,
          bar_error: typeof payload.bar_error === 'string' ? payload.bar_error : null,
          checked_at: row.created_at,
        }
      } else if (row.kind === 's12') {
        const overlay = payload.assist_entry_overlay
        preview.s12 = {
          state: String(payload.state ?? row.status),
          reason: String(payload.reason ?? row.reason ?? ''),
          ready: payload.ready === true,
          entry_price: payload.ready === true ? finitePositive(overlay?.entryPrice) : null,
          chase_ceiling: payload.ready === true ? finitePositive(overlay?.chaseCeiling) : null,
          checked_at: row.created_at,
        }
      } else {
        const detail = typeof payload.detail === 'string' ? payload.detail : ''
        preview.allocator = {
          action: row.status.replace(/^allocator_/, ''),
          reason: String(row.reason ?? ''),
          budget_cap: finiteNonnegative(detailField(detail, 'budget')),
          target_value: finiteNonnegative(detailField(detail, 'target')),
          available_cash: finiteNonnegative(detailField(detail, 'available_cash')),
          l5_status: detailField(detail, 'l5_status'),
          l5_reasons: (detailField(detail, 'l5_reasons') ?? '').split('|').filter(Boolean),
          s12_hard_veto: detailField(detail, 's12_hard_veto') === 'true',
          checked_at: row.created_at,
        }
      }
      previews.set(row.symbol, preview)
    } catch {
      // A malformed audit event must not invent an execution price or budget.
    }
  }
  return previews
}

export async function loadPendingBuyExecutionPreviews(
  env: Bindings,
  tradeDate: string,
  symbols: string[],
): Promise<Map<string, PendingBuyExecutionPreview>> {
  if (symbols.length === 0) return new Map()
  const owner = String(env.PAPER_INTRADAY_ENTRY_OWNER ?? '').trim()
  const entryOwner = owner === 'or15-5m-orl8-20-v1' ? owner : owner === 'or15_vwap_v1' ? owner : 's12'
  const placeholders = symbols.map(() => '?').join(',')
  const { results } = await paperDomainDatabase(env).prepare(`
    WITH candidate_events AS (
      SELECT symbol, status, reason, detail_json, created_at, id,
             CASE
               WHEN event_type = 's12_intraday_structure' AND source = 's12_intraday_structure' THEN 's12'
               WHEN event_type = 'intraday_technical_decision' AND source IN ('or15_vwap_entry_v1','or15-5m-orl8-20-v1') THEN 'or15'
               ELSE 'allocator'
             END AS kind
        FROM paper_execution_events
       WHERE account_id = ? AND trade_date = ?
         AND created_at >= datetime('now', '-5 minutes')
         AND symbol IN (${placeholders})
         AND (
           (event_type = 's12_intraday_structure' AND source = 's12_intraday_structure')
           OR (event_type = 'intraday_technical_decision' AND source IN ('or15_vwap_entry_v1','or15-5m-orl8-20-v1'))
           OR (event_type = 'pending_buy' AND source = 'intraday_check' AND status LIKE 'allocator_%')
         )
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol, kind ORDER BY id DESC) AS rn
        FROM candidate_events
    )
    SELECT symbol, kind, status, reason, detail_json, created_at
      FROM ranked WHERE rn = 1
  `).bind(1, tradeDate, ...symbols).all<ExecutionPreviewRow>()
  const previews = buildPendingBuyExecutionPreviews(results ?? [], entryOwner)
  for (const symbol of symbols) {
    if (!previews.has(symbol)) previews.set(symbol, { entry_owner: entryOwner, or15: null, s12: null, allocator: null })
  }
  return previews
}
