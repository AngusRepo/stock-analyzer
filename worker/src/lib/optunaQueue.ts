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
export const OPTUNA_QUEUE_PROCESSOR_LOCK_KEY = 'lock:optuna-queue-processor'
export const OPTUNA_QUEUE_PROCESSOR_D1_LOCK_KEY = 'optuna-queue:processor'
const PROCESSED_TTL_DAYS = 7

export type OptunaQueueReason = 'regime_shift' | 'sharpe_rolling' | 'dd_spike' | 'manual'
export type OptunaQueueStatus = 'pending' | 'in_progress' | 'processed' | 'failed'
export type OptunaTriggerSource = 'regime_change' | 'risk_anomaly' | 'manual_research' | 'queue'

export interface OptunaQueueEntry {
  id: string
  reason: OptunaQueueReason
  target: string
  enqueued_at: string
  trigger_source?: OptunaTriggerSource
  idempotency_key?: string
  cooldown_key?: string
  cooldown_until?: string
  regime_hint?: string
  status: OptunaQueueStatus
  processing_started_at?: string
  processed_at?: string
  run_id?: string
  sandbox_id?: string
  error?: string
  note?: string
}

export interface OptunaD1LockResult {
  acquired: boolean
  lock_key: string
  run_id: string
  expires_at: string
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

export function optunaTriggerSourceForReason(reason: OptunaQueueReason): OptunaTriggerSource {
  if (reason === 'regime_shift') return 'regime_change'
  if (reason === 'sharpe_rolling' || reason === 'dd_spike') return 'risk_anomaly'
  if (reason === 'manual') return 'manual_research'
  return 'queue'
}

function cooldownHoursForReason(reason: OptunaQueueReason): number {
  if (reason === 'manual') return 0
  return 24
}

function buildIdempotencyKey(params: {
  reason: OptunaQueueReason
  target: string
  regime_hint?: string
}): string {
  return `${params.target}:${params.reason}:${params.regime_hint ?? 'all'}:${today()}`
}

function buildCooldownKey(params: {
  reason: OptunaQueueReason
  target: string
  regime_hint?: string
}): string {
  return `optuna:cooldown:${params.target}:${params.reason}:${params.regime_hint ?? 'all'}`
}

function entryRunDate(entry: OptunaQueueEntry): string {
  const match = entry.id.match(/(\d{4}-\d{2}-\d{2})$/)
  return match?.[1] ?? today()
}

function buildRunLockKey(entry: OptunaQueueEntry): string {
  return `optuna:run:${entry.id}`
}

export function optunaRunLockKeyFromRunId(runId: string): string {
  return `optuna:run:${runId}`
}

export function optunaRunDateFromRunId(runId?: string): string | undefined {
  const match = String(runId ?? '').match(/(\d{4}-\d{2}-\d{2})$/)
  return match?.[1]
}

async function acquireD1SchedulerLock(
  db: D1Database,
  params: {
    lockKey: string
    owner: string
    runDate?: string
    runId: string
    ttlSec: number
  },
): Promise<OptunaD1LockResult> {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + Math.max(60, params.ttlSec) * 1000).toISOString()
  const result = await db.prepare(`
    INSERT INTO scheduler_locks (lock_key, owner, run_date, run_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(lock_key) DO UPDATE SET
      owner=excluded.owner,
      run_date=excluded.run_date,
      run_id=excluded.run_id,
      created_at=excluded.created_at,
      expires_at=excluded.expires_at
    WHERE scheduler_locks.expires_at IS NOT NULL
      AND scheduler_locks.expires_at <= excluded.created_at
  `).bind(
    params.lockKey,
    params.owner,
    params.runDate ?? null,
    params.runId,
    now,
    expiresAt,
  ).run()
  return {
    acquired: Number(result.meta?.changes ?? 0) > 0,
    lock_key: params.lockKey,
    run_id: params.runId,
    expires_at: expiresAt,
  }
}

export async function acquireOptunaQueueProcessorD1Lock(
  db: D1Database,
  runId: string,
  ttlSec = 3600,
): Promise<OptunaD1LockResult> {
  return acquireD1SchedulerLock(db, {
    lockKey: OPTUNA_QUEUE_PROCESSOR_D1_LOCK_KEY,
    owner: 'optuna_queue_processor',
    runDate: today(),
    runId,
    ttlSec,
  })
}

export async function releaseOptunaQueueProcessorD1Lock(db: D1Database, runId: string): Promise<void> {
  await db.prepare(`
    DELETE FROM scheduler_locks
    WHERE lock_key = ? AND run_id = ?
  `).bind(OPTUNA_QUEUE_PROCESSOR_D1_LOCK_KEY, runId).run()
}

export async function acquireOptunaRunD1Lock(
  db: D1Database,
  entry: OptunaQueueEntry,
  runId: string,
  ttlSec = 6 * 3600,
): Promise<OptunaD1LockResult> {
  return acquireD1SchedulerLock(db, {
    lockKey: buildRunLockKey(entry),
    owner: 'optuna_per_regime_run',
    runDate: entryRunDate(entry),
    runId,
    ttlSec,
  })
}

export async function closeOptunaRunD1Lock(
  db: D1Database,
  runId: string,
  status: string,
): Promise<{ closed: boolean; lock_key: string }> {
  const lockKey = optunaRunLockKeyFromRunId(runId)
  const now = new Date().toISOString()
  const normalized = String(status || 'unknown').replace(/[^a-z0-9_:-]+/gi, '_').slice(0, 40)
  const result = await db.prepare(`
    UPDATE scheduler_locks
       SET owner = ?,
           expires_at = ?
     WHERE lock_key = ?
  `).bind(`optuna_per_regime_run_${normalized}`, now, lockKey).run()
  return {
    closed: Number(result.meta?.changes ?? 0) > 0,
    lock_key: lockKey,
  }
}

/**
 * Enqueue an Optuna request. Idempotent by target/reason/regime/day and guarded
 * by a short KV cooldown for event triggers. Manual research bypasses cooldown.
 */
export async function enqueueOptunaRequest(
  kv: KVNamespace,
  params: {
    reason: OptunaQueueReason
    target: string
    regime_hint?: string
    note?: string
    cooldownHours?: number
  },
): Promise<{ enqueued: boolean; id: string }> {
  const id = buildIdempotencyKey(params)
  const cooldownHours = params.cooldownHours ?? cooldownHoursForReason(params.reason)
  const cooldownKey = buildCooldownKey(params)
  if (cooldownHours > 0 && await kv.get(cooldownKey)) {
    return { enqueued: false, id }
  }
  const entries = await readQueue(kv)
  const existing = entries.find(e => e.id === id || e.idempotency_key === id)
  if (existing) {
    return { enqueued: false, id }
  }
  const enqueuedAt = new Date().toISOString()
  const cooldownUntil = cooldownHours > 0
    ? new Date(Date.now() + cooldownHours * 3600_000).toISOString()
    : undefined
  entries.unshift({
    id,
    reason: params.reason,
    target: params.target,
    enqueued_at: enqueuedAt,
    trigger_source: optunaTriggerSourceForReason(params.reason),
    idempotency_key: id,
    cooldown_key: cooldownHours > 0 ? cooldownKey : undefined,
    cooldown_until: cooldownUntil,
    regime_hint: params.regime_hint,
    status: 'pending',
    note: params.note,
  })
  await writeQueue(kv, entries)
  if (cooldownHours > 0) {
    await kv.put(cooldownKey, enqueuedAt, { expirationTtl: Math.ceil(cooldownHours * 3600) })
  }
  return { enqueued: true, id }
}

export async function acquireOptunaQueueProcessorLock(
  kv: KVNamespace,
  runId: string,
  ttlSec = 3600,
): Promise<boolean> {
  const existing = await kv.get(OPTUNA_QUEUE_PROCESSOR_LOCK_KEY)
  if (existing) return false
  await kv.put(
    OPTUNA_QUEUE_PROCESSOR_LOCK_KEY,
    JSON.stringify({ run_id: runId, acquired_at: new Date().toISOString() }),
    { expirationTtl: Math.max(60, ttlSec) },
  )
  return true
}

export async function releaseOptunaQueueProcessorLock(kv: KVNamespace, runId: string): Promise<void> {
  const raw = await kv.get(OPTUNA_QUEUE_PROCESSOR_LOCK_KEY, 'json') as { run_id?: string } | null
  if (raw?.run_id === runId) {
    await kv.delete(OPTUNA_QUEUE_PROCESSOR_LOCK_KEY)
  }
}

/**
 * Atomically claim the oldest pending entry (FIFO) for processing. Marks it
 * `in_progress` in KV before returning. Returns null when queue empty.
 */
export async function popNextPending(kv: KVNamespace): Promise<OptunaQueueEntry | null> {
  const entries = await readQueue(kv)
  const idx = entries.findIndex(e => e.status === 'pending')
  if (idx < 0) return null
  const claimed = {
    ...entries[idx],
    status: 'in_progress' as OptunaQueueStatus,
    processing_started_at: new Date().toISOString(),
  }
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
