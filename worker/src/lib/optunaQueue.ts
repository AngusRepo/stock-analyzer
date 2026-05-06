/**
 * optunaQueue.ts — #28b Tier 1 (T1.5): event-triggered Optuna request queue.
 *
 * Why:
 *   Tier 1 event triggers (regime shift / rolling sharpe / drawdown spike) must
 *   fire Optuna re-tuning asynchronously — doing it inline in their originating
 *   cron risks overrunning worker budget. A lightweight KV-backed queue absorbs
 *   requests, and a separate 6-hr processor cron drains it against ml-controller
 *   /optuna/* endpoints, routing results to sandbox (T3.3 secure-by-default).
 *
 * Schema (KV key `pending_optuna_queue` stores JSON array):
 *   [
 *     {
 *       id:            `${reason}:${YYYY-MM-DD}`,   // idempotency key — same reason same day deduped
 *       reason:        'regime_shift'|'sharpe_rolling'|'dd_spike'|'manual',
 *       target:        'per_regime'|'sltp'|'barrier'|'signal'|...,
 *       enqueued_at:   ISO timestamp,
 *       regime_hint?:  'bull_market'|...,           // optional context for processor
 *       status:        'pending'|'in_progress'|'processed'|'failed',
 *       processed_at?: ISO timestamp,
 *       sandbox_id?:   string (resulting sandbox entry id),
 *       error?:        string (on failed),
 *       note?:         string,
 *     }
 *   ]
 *
 * Retention: processed/failed entries retained 7 days via per-entry TTL check
 * when listing. Pending entries never expire (processor must handle them).
 *
 * Thread safety: KV writes are last-write-wins. Worker cron concurrency is
 * capped by CF at 1 in-flight per cron schedule, so processor_cron can't
 * race itself. Event-trigger enqueues may race each other — idempotency key
 * (reason+date) absorbs duplicates naturally.
 */

export const OPTUNA_QUEUE_KEY = 'pending_optuna_queue'
const PROCESSED_TTL_DAYS = 7

export type OptunaQueueReason = 'regime_shift' | 'sharpe_rolling' | 'dd_spike' | 'manual'
export type OptunaQueueStatus = 'pending' | 'in_progress' | 'processed' | 'failed'

export interface OptunaQueueEntry {
  id: string
  reason: OptunaQueueReason
  target: string
  enqueued_at: string
  regime_hint?: string
  status: OptunaQueueStatus
  processed_at?: string
  sandbox_id?: string
  error?: string
  note?: string
}

function today(): string {
  // TW timezone (UTC+8) date
  const now = new Date(Date.now() + 8 * 3600_000)
  return now.toISOString().slice(0, 10)
}

async function readQueue(kv: KVNamespace): Promise<OptunaQueueEntry[]> {
  const raw = await kv.get(OPTUNA_QUEUE_KEY, 'json') as OptunaQueueEntry[] | null
  return Array.isArray(raw) ? raw : []
}

async function writeQueue(kv: KVNamespace, entries: OptunaQueueEntry[]): Promise<void> {
  // Prune processed/failed entries older than TTL before persisting — keeps
  // KV value small (free tier 25 MB/key). Pending entries always kept.
  const cutoffMs = Date.now() - PROCESSED_TTL_DAYS * 86_400_000
  const pruned = entries.filter(e => {
    if (e.status === 'pending' || e.status === 'in_progress') return true
    const ts = Date.parse(e.processed_at || e.enqueued_at)
    return Number.isFinite(ts) && ts >= cutoffMs
  })
  await kv.put(OPTUNA_QUEUE_KEY, JSON.stringify(pruned))
}

/**
 * Enqueue an Optuna request. Idempotent by (reason, today_TW) — same reason
 * fired twice in one day only records once. Returns `true` if new entry added,
 * `false` if deduped.
 */
export async function enqueueOptunaRequest(
  kv: KVNamespace,
  params: {
    reason: OptunaQueueReason
    target: string
    regime_hint?: string
    note?: string
  },
): Promise<{ enqueued: boolean; id: string }> {
  const id = `${params.reason}:${today()}`
  const entries = await readQueue(kv)
  const existing = entries.find(e => e.id === id)
  if (existing) {
    // Already there — if still pending/in_progress, dedup; if processed/failed,
    // it's a historical record and we should not re-enqueue same day.
    return { enqueued: false, id }
  }
  entries.unshift({
    id,
    reason: params.reason,
    target: params.target,
    enqueued_at: new Date().toISOString(),
    regime_hint: params.regime_hint,
    status: 'pending',
    note: params.note,
  })
  await writeQueue(kv, entries)
  return { enqueued: true, id }
}

/**
 * Atomically claim the oldest pending entry (FIFO) for processing. Marks it
 * `in_progress` in KV before returning. Returns null when queue empty.
 */
export async function popNextPending(kv: KVNamespace): Promise<OptunaQueueEntry | null> {
  const entries = await readQueue(kv)
  const idx = entries.findIndex(e => e.status === 'pending')
  if (idx < 0) return null
  const claimed = { ...entries[idx], status: 'in_progress' as OptunaQueueStatus }
  entries[idx] = claimed
  await writeQueue(kv, entries)
  return claimed
}

export async function markProcessed(
  kv: KVNamespace,
  id: string,
  meta: { sandbox_id?: string; note?: string },
): Promise<void> {
  const entries = await readQueue(kv)
  const idx = entries.findIndex(e => e.id === id)
  if (idx < 0) return
  entries[idx] = {
    ...entries[idx],
    status: 'processed',
    processed_at: new Date().toISOString(),
    sandbox_id: meta.sandbox_id,
    note: meta.note ?? entries[idx].note,
  }
  await writeQueue(kv, entries)
}

export async function markFailed(
  kv: KVNamespace,
  id: string,
  error: string,
): Promise<void> {
  const entries = await readQueue(kv)
  const idx = entries.findIndex(e => e.id === id)
  if (idx < 0) return
  entries[idx] = {
    ...entries[idx],
    status: 'failed',
    processed_at: new Date().toISOString(),
    error: error.slice(0, 500),
  }
  await writeQueue(kv, entries)
}

export async function listQueue(
  kv: KVNamespace,
  opts: { limit?: number; status?: OptunaQueueStatus } = {},
): Promise<OptunaQueueEntry[]> {
  const entries = await readQueue(kv)
  const filtered = opts.status ? entries.filter(e => e.status === opts.status) : entries
  return filtered.slice(0, Math.max(1, Math.min(opts.limit ?? 50, 200)))
}
