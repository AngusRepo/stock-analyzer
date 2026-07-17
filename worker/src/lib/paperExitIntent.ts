import type { Bindings } from '../types'

export const ACTIVE_PAPER_EXIT_INTENT_STATES = [
  'EXIT_TRIGGERED_WAITING_BOOK',
  'SUBMITTING',
  'PARTIAL',
] as const

export type PaperExitIntentState =
  | typeof ACTIVE_PAPER_EXIT_INTENT_STATES[number]
  | 'FILLED'
  | 'CANCELLED'
  | 'SUPERSEDED'

export type PaperStopBreachPayload = {
  schema_version?: string
  intent_key: string
  account_id: number
  symbol: string
  entry_date?: string | null
  requested_shares: number
  stop_price: number
  stop_version: string
  trigger_price: number
  trigger_time?: string | null
  received_at: string
  session_epoch?: number | null
  source: string
}

export type PaperExitQueueMsg = {
  type: 'paper_exit_intent'
  intentKey: string
  symbol: string
  attempt: number
  triggerTime: string
}

export type PaperExitIntentRow = {
  intent_key: string
  account_id: number
  trade_date: string
  symbol: string
  entry_date: string | null
  requested_shares: number
  remaining_shares: number
  stop_price: number
  stop_version: string
  trigger_price: number
  trigger_time: string | null
  received_at: string
  session_epoch: number | null
  trigger_source: string
  state: PaperExitIntentState
  attempt_count: number
  last_error: string | null
}

export type HubStopWatch = {
  intent_key: string
  account_id: number
  symbol: string
  entry_date: string | null
  requested_shares: number
  stop_price: number
  stop_version: string
}

export function applyLatchedPaperExitIntent<
  T extends { action: string; reason: string; exitIntentKind?: string },
>(decision: T, intent: Pick<PaperExitIntentRow, 'trigger_source' | 'stop_price'>): T {
  return {
    ...decision,
    action: 'full_sell',
    reason: `latched_stop_breach:${intent.trigger_source}:${intent.stop_price}`,
    exitIntentKind: 'risk_stop',
  }
}

function finitePositive(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function twTradeDate(value: string): string {
  const parsed = Date.parse(value)
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date()
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

export function normalizePaperStopBreach(payload: unknown): PaperStopBreachPayload | null {
  const raw = payload as Record<string, unknown> | null
  if (!raw) return null
  const intentKey = String(raw.intent_key ?? '').trim()
  const symbol = String(raw.symbol ?? '').trim().toUpperCase()
  const stopPrice = finitePositive(raw.stop_price)
  const triggerPrice = finitePositive(raw.trigger_price)
  const requestedShares = Math.max(0, Math.floor(Number(raw.requested_shares ?? 0)))
  const receivedAt = String(raw.received_at ?? '').trim()
  if (!intentKey || !symbol || stopPrice == null || triggerPrice == null || requestedShares <= 0 || !receivedAt) {
    return null
  }
  return {
    schema_version: String(raw.schema_version ?? 'paper-stop-breach-v1'),
    intent_key: intentKey,
    account_id: Math.max(1, Math.floor(Number(raw.account_id ?? 1))),
    symbol,
    entry_date: raw.entry_date == null ? null : String(raw.entry_date),
    requested_shares: requestedShares,
    stop_price: stopPrice,
    stop_version: String(raw.stop_version ?? stopPrice.toFixed(4)),
    trigger_price: triggerPrice,
    trigger_time: raw.trigger_time == null ? null : String(raw.trigger_time),
    received_at: receivedAt,
    session_epoch: Number.isFinite(Number(raw.session_epoch)) ? Number(raw.session_epoch) : null,
    source: String(raw.source ?? 'unknown'),
  }
}

export async function persistPaperStopBreach(
  env: Pick<Bindings, 'DB' | 'PAPER_EXIT_QUEUE'>,
  rawPayload: unknown,
): Promise<{ inserted: boolean; intent: PaperStopBreachPayload }> {
  const intent = normalizePaperStopBreach(rawPayload)
  if (!intent) throw new Error('invalid_paper_stop_breach_payload')
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO paper_exit_intents (
      intent_key, account_id, trade_date, symbol, entry_date,
      requested_shares, remaining_shares, stop_price, stop_version,
      trigger_price, trigger_time, received_at, session_epoch, trigger_source,
      state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXIT_TRIGGERED_WAITING_BOOK')
  `).bind(
    intent.intent_key,
    intent.account_id,
    twTradeDate(intent.trigger_time ?? intent.received_at),
    intent.symbol,
    intent.entry_date ?? null,
    intent.requested_shares,
    intent.requested_shares,
    intent.stop_price,
    intent.stop_version,
    intent.trigger_price,
    intent.trigger_time ?? null,
    intent.received_at,
    intent.session_epoch ?? null,
    intent.source,
  ).run()
  const inserted = Number(result.meta?.changes ?? 0) > 0
  if (inserted) {
    await env.PAPER_EXIT_QUEUE.send({
      type: 'paper_exit_intent',
      intentKey: intent.intent_key,
      symbol: intent.symbol,
      attempt: 0,
      triggerTime: intent.trigger_time ?? intent.received_at,
    })
  }
  return { inserted, intent }
}

export async function loadActivePaperExitIntent(
  db: D1Database,
  accountId: number,
  symbol: string,
  entryDate?: string | null,
): Promise<PaperExitIntentRow | null> {
  return db.prepare(`
    SELECT *
      FROM paper_exit_intents
     WHERE account_id = ?
       AND symbol = ?
       AND state IN ('EXIT_TRIGGERED_WAITING_BOOK', 'SUBMITTING', 'PARTIAL')
       AND (? IS NULL OR entry_date = ?)
     ORDER BY created_at ASC
     LIMIT 1
  `).bind(accountId, symbol, entryDate ?? null, entryDate ?? null).first<PaperExitIntentRow>()
}

export async function markPaperExitIntentAttempt(
  db: D1Database,
  intentKey: string,
  state: Extract<PaperExitIntentState, 'EXIT_TRIGGERED_WAITING_BOOK' | 'SUBMITTING' | 'PARTIAL'>,
  detail: { remainingShares?: number; error?: string | null; retryAfterSeconds?: number } = {},
): Promise<void> {
  const retryAfterSeconds = Math.max(1, Math.min(300, Math.floor(detail.retryAfterSeconds ?? 10)))
  await db.prepare(`
    UPDATE paper_exit_intents
       SET state = ?,
           remaining_shares = COALESCE(?, remaining_shares),
           attempt_count = attempt_count + 1,
           last_attempt_at = datetime('now'),
           next_attempt_at = datetime('now', ?),
           last_error = ?,
           updated_at = datetime('now')
     WHERE intent_key = ?
       AND state NOT IN ('FILLED', 'CANCELLED', 'SUPERSEDED')
  `).bind(
    state,
    detail.remainingShares ?? null,
    `+${retryAfterSeconds} seconds`,
    detail.error ?? null,
    intentKey,
  ).run()
}

export async function resolvePaperExitIntent(
  db: D1Database,
  intentKey: string,
  input: { state: 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'SUPERSEDED'; remainingShares: number; orderId?: number | null },
): Promise<void> {
  await db.prepare(`
    UPDATE paper_exit_intents
       SET state = ?,
           remaining_shares = ?,
           resolution_order_id = COALESCE(?, resolution_order_id),
           resolved_at = CASE WHEN ? IN ('FILLED', 'CANCELLED', 'SUPERSEDED') THEN datetime('now') ELSE NULL END,
           next_attempt_at = CASE WHEN ? = 'PARTIAL' THEN datetime('now', '+10 seconds') ELSE NULL END,
           last_error = NULL,
           updated_at = datetime('now')
     WHERE intent_key = ?
  `).bind(input.state, input.remainingShares, input.orderId ?? null, input.state, input.state, intentKey).run()
}

export async function syncHubStopWatchesAndBreaches(
  env: Pick<Bindings, 'DB' | 'PAPER_EXIT_QUEUE' | 'SHIOAJI_PROXY_URL' | 'PROXY_SERVICE_TOKEN'>,
  watches: HubStopWatch[],
  options: { ttlSeconds?: number } = {},
): Promise<{ registered: number; breaches: number; errors: string[] }> {
  if (!env.SHIOAJI_PROXY_URL || watches.length === 0) return { registered: 0, breaches: 0, errors: [] }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.PROXY_SERVICE_TOKEN) headers.Authorization = `Bearer ${env.PROXY_SERVICE_TOKEN}`
  const errors: string[] = []
  let registered = 0
  let breaches = 0
  try {
    const response = await fetch(`${env.SHIOAJI_PROXY_URL}/execution/stop-watches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ watches, ttl_seconds: options.ttlSeconds ?? 180 }),
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) throw new Error(`stop_watch_http_${response.status}`)
    const body = await response.json() as any
    registered = Number(body?.registered ?? 0)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const response = await fetch(`${env.SHIOAJI_PROXY_URL}/execution/stop-breaches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ intent_keys: watches.map((watch) => watch.intent_key) }),
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) throw new Error(`stop_breach_http_${response.status}`)
    const body = await response.json() as any
    for (const payload of Array.isArray(body?.data) ? body.data : []) {
      const result = await persistPaperStopBreach(env, payload)
      if (result.inserted) breaches += 1
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return { registered, breaches, errors }
}
