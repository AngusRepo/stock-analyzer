import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'

export type SchedulerExecutionTicketStatus =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'triggered'
  | 'success'
  | 'error'
  | 'skipped'
  | 'blocked'

export type SchedulerExecutionTicketAuthority =
  | 'scheduler_http'
  | 'durable_queue'
  | 'durable_pipeline_stage'
  | 'logical_child'

export type SchedulerExecutionTicketKind = 'physical_root' | 'logical_child' | 'manual'

export type SchedulerExecutionTicketRow = {
  ticket_id: string
  dedupe_key: string
  root_ticket_id: string
  parent_ticket_id: string | null
  scheduler_job_id: string | null
  task: string
  business_date: string
  scheduled_at: string | null
  run_id: string
  attempt_id: string
  ticket_kind: SchedulerExecutionTicketKind
  status: SchedulerExecutionTicketStatus
  status_authority: SchedulerExecutionTicketAuthority
  attempt_count: number
  payload_checksum: string
  last_summary: string | null
  last_error: string | null
  metadata_json: string
  accepted_at: string
  started_at: string | null
  completed_at: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export type SchedulerDeliveryIdentity = {
  schedulerJobId: string | null
  scheduledAt: string | null
  ticketKind: 'physical_root' | 'manual'
}

export type SchedulerTicketAdmission = {
  ticket: SchedulerExecutionTicketRow
  shouldExecute: boolean
  reason: 'admitted' | 'retry_admitted' | 'duplicate_inflight' | 'duplicate_terminal' | 'attempt_limit'
}

type ManifestJob = { id: string; task: string }
const MANIFEST_JOBS = (schedulerManifest as { jobs: ManifestJob[] }).jobs
const MANIFEST_BY_ID = new Map(MANIFEST_JOBS.map((job) => [job.id, job]))
const TERMINAL_STATUSES = new Set<SchedulerExecutionTicketStatus>(['success', 'error', 'skipped', 'blocked'])
const MAX_ATTEMPTS = 3

function normalizeSchedulerTimestamp(value: string | null): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid Cloud Scheduler schedule time: ${value}`)
  return new Date(parsed).toISOString()
}

function schedulerJobIdFromHeader(value: string | null): string | null {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null
  const jobId = normalized.split('/').filter(Boolean).at(-1) ?? ''
  if (!/^[a-z][a-z0-9-]{0,499}$/.test(jobId)) {
    throw new Error(`invalid Cloud Scheduler job name: ${normalized}`)
  }
  return jobId
}

export function schedulerDeliveryIdentity(headers: Headers): SchedulerDeliveryIdentity {
  const schedulerJobId = schedulerJobIdFromHeader(headers.get('X-CloudScheduler-JobName'))
  const scheduleHeader = headers.get('X-CloudScheduler-ScheduleTime')
  if (!schedulerJobId && scheduleHeader) {
    throw new Error('Cloud Scheduler schedule time is present without a job name')
  }
  const scheduledAt = normalizeSchedulerTimestamp(scheduleHeader)
  if (schedulerJobId && !scheduledAt) {
    throw new Error('Cloud Scheduler job name is present without a schedule time')
  }
  return {
    schedulerJobId,
    scheduledAt,
    ticketKind: schedulerJobId ? 'physical_root' : 'manual',
  }
}

export function assertSchedulerManifestDelivery(identity: SchedulerDeliveryIdentity, task: string): void {
  if (!identity.schedulerJobId) return
  const manifestJob = MANIFEST_BY_ID.get(identity.schedulerJobId)
  if (!manifestJob) throw new Error(`unmanaged Cloud Scheduler job: ${identity.schedulerJobId}`)
  if (manifestJob.task !== task) {
    throw new Error(
      `Cloud Scheduler task mismatch: job=${identity.schedulerJobId} manifest=${manifestJob.task} request=${task}`,
    )
  }
}

function twBusinessDate(timestamp: string | null): string {
  const base = timestamp ? Date.parse(timestamp) : Date.now()
  return new Date(base + 8 * 3_600_000).toISOString().slice(0, 10)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function ticketAttemptId(ticketId: string, attemptCount: number): string {
  return `${ticketId}:attempt:${attemptCount}`
}

async function readTicket(db: D1Database, ticketId: string): Promise<SchedulerExecutionTicketRow> {
  const row = await db.prepare(`
    SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?
  `).bind(ticketId).first<SchedulerExecutionTicketRow>()
  if (!row) throw new Error(`scheduler execution ticket readback missing: ${ticketId}`)
  return row
}

export async function admitSchedulerExecutionTicket(
  db: D1Database,
  input: {
    identity: SchedulerDeliveryIdentity
    task: string
    requestedRunDate?: string
    proposedRunId: string
    metadata?: Record<string, unknown>
  },
): Promise<SchedulerTicketAdmission> {
  assertSchedulerManifestDelivery(input.identity, input.task)
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.requestedRunDate ?? ''))
    ? String(input.requestedRunDate)
    : twBusinessDate(input.identity.scheduledAt)
  const dedupeKey = input.identity.schedulerJobId
    ? `scheduler:${input.identity.schedulerJobId}:${input.identity.scheduledAt}:${input.task}`
    : `manual:${input.proposedRunId}`
  const ticketId = `scheduler-ticket-v1-${(await sha256Hex(dedupeKey)).slice(0, 40)}`
  const payload = JSON.stringify({
    scheduler_job_id: input.identity.schedulerJobId,
    scheduled_at: input.identity.scheduledAt,
    task: input.task,
    business_date: businessDate,
  })
  const payloadChecksum = `sha256:${await sha256Hex(payload)}`
  const attemptId = ticketAttemptId(ticketId, 1)
  const insert = await db.prepare(`
    INSERT OR IGNORE INTO scheduler_execution_tickets_v1 (
      ticket_id, dedupe_key, root_ticket_id, parent_ticket_id,
      scheduler_job_id, task, business_date, scheduled_at, run_id, attempt_id,
      ticket_kind, status, status_authority, attempt_count, payload_checksum,
      metadata_json
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'accepted', 'scheduler_http', 1, ?, ?)
  `).bind(
    ticketId,
    dedupeKey,
    ticketId,
    input.identity.schedulerJobId,
    input.task,
    businessDate,
    input.identity.scheduledAt,
    input.proposedRunId,
    attemptId,
    input.identity.ticketKind,
    payloadChecksum,
    JSON.stringify(input.metadata ?? {}),
  ).run()
  if (Number(insert.meta?.changes ?? 0) === 1) {
    return { ticket: await readTicket(db, ticketId), shouldExecute: true, reason: 'admitted' }
  }

  const existing = await readTicket(db, ticketId)
  if (existing.dedupe_key !== dedupeKey || existing.payload_checksum !== payloadChecksum) {
    throw new Error(`scheduler execution ticket immutable identity conflict: ${ticketId}`)
  }
  if ((existing.status === 'error' || existing.status === 'blocked') && existing.attempt_count < MAX_ATTEMPTS) {
    const nextAttempt = existing.attempt_count + 1
    const retry = await db.prepare(`
      UPDATE scheduler_execution_tickets_v1
         SET status='accepted', status_authority='scheduler_http',
             attempt_count=?, attempt_id=?, last_summary=NULL, last_error=NULL,
             accepted_at=CURRENT_TIMESTAMP, started_at=NULL, completed_at=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE ticket_id=? AND run_id=? AND payload_checksum=?
         AND status IN ('error','blocked') AND attempt_count=?
    `).bind(
      nextAttempt,
      ticketAttemptId(ticketId, nextAttempt),
      ticketId,
      existing.run_id,
      payloadChecksum,
      existing.attempt_count,
    ).run()
    if (Number(retry.meta?.changes ?? 0) === 1) {
      return { ticket: await readTicket(db, ticketId), shouldExecute: true, reason: 'retry_admitted' }
    }
  }

  const current = await readTicket(db, ticketId)
  return {
    ticket: current,
    shouldExecute: false,
    reason: (current.status === 'error' || current.status === 'blocked') && current.attempt_count >= MAX_ATTEMPTS
      ? 'attempt_limit'
      : TERMINAL_STATUSES.has(current.status)
        ? 'duplicate_terminal'
        : 'duplicate_inflight',
  }
}

const ALLOWED_PREVIOUS: Record<SchedulerExecutionTicketStatus, readonly SchedulerExecutionTicketStatus[]> = {
  accepted: ['accepted'],
  queued: ['accepted', 'queued'],
  running: ['accepted', 'queued', 'running'],
  triggered: ['accepted', 'queued', 'running', 'triggered'],
  success: ['accepted', 'queued', 'running', 'triggered', 'success'],
  error: ['accepted', 'queued', 'running', 'triggered', 'error'],
  skipped: ['accepted', 'queued', 'running', 'triggered', 'skipped'],
  blocked: ['accepted', 'blocked'],
}

export async function updateSchedulerExecutionTicket(
  db: D1Database,
  input: {
    ticketId: string
    runId: string
    status: SchedulerExecutionTicketStatus
    authority: SchedulerExecutionTicketAuthority
    summary?: string
    error?: string
  },
): Promise<SchedulerExecutionTicketRow> {
  const allowed = ALLOWED_PREVIOUS[input.status]
  const terminal = TERMINAL_STATUSES.has(input.status)
  const placeholders = allowed.map(() => '?').join(', ')
  const result = await db.prepare(`
    UPDATE scheduler_execution_tickets_v1
       SET status=?, status_authority=?, last_summary=?, last_error=?,
           started_at=CASE
             WHEN ? IN ('queued','running','triggered','success','error')
             THEN COALESCE(started_at, CURRENT_TIMESTAMP)
             ELSE started_at
           END,
           completed_at=CASE WHEN ?=1 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
           updated_at=CURRENT_TIMESTAMP
     WHERE ticket_id=? AND run_id=? AND status IN (${placeholders})
  `).bind(
    input.status,
    input.authority,
    input.summary ?? null,
    input.error ?? null,
    input.status,
    terminal ? 1 : 0,
    input.ticketId,
    input.runId,
    ...allowed,
  ).run()
  const row = await readTicket(db, input.ticketId)
  if (Number(result.meta?.changes ?? 0) !== 1 && row.status !== input.status) {
    throw new Error(
      `scheduler ticket transition rejected: ticket=${input.ticketId} current=${row.status} requested=${input.status}`,
    )
  }
  return row
}

export async function admitSchedulerChildTicket(
  db: D1Database,
  input: {
    rootTicketId: string
    parentTicketId: string
    childKey: string
    task: string
    businessDate: string
    runId: string
    metadata?: Record<string, unknown>
  },
): Promise<SchedulerExecutionTicketRow> {
  const parent = await readTicket(db, input.parentTicketId)
  if (parent.root_ticket_id !== input.rootTicketId && parent.ticket_id !== input.rootTicketId) {
    throw new Error(`scheduler child parent/root mismatch: ${input.parentTicketId}`)
  }
  const dedupeKey = `child:${input.parentTicketId}:${input.childKey}`
  const ticketId = `scheduler-ticket-v1-${(await sha256Hex(dedupeKey)).slice(0, 40)}`
  const payloadChecksum = `sha256:${await sha256Hex(JSON.stringify({
    root_ticket_id: input.rootTicketId,
    parent_ticket_id: input.parentTicketId,
    child_key: input.childKey,
    task: input.task,
    business_date: input.businessDate,
  }))}`
  await db.prepare(`
    INSERT OR IGNORE INTO scheduler_execution_tickets_v1 (
      ticket_id, dedupe_key, root_ticket_id, parent_ticket_id,
      scheduler_job_id, task, business_date, scheduled_at, run_id, attempt_id,
      ticket_kind, status, status_authority, attempt_count, payload_checksum,
      metadata_json
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, 'logical_child', 'accepted', 'logical_child', 1, ?, ?)
  `).bind(
    ticketId,
    dedupeKey,
    input.rootTicketId,
    input.parentTicketId,
    input.task,
    input.businessDate,
    input.runId,
    ticketAttemptId(ticketId, 1),
    payloadChecksum,
    JSON.stringify(input.metadata ?? {}),
  ).run()
  const child = await readTicket(db, ticketId)
  if (child.payload_checksum !== payloadChecksum) {
    throw new Error(`scheduler child ticket immutable identity conflict: ${ticketId}`)
  }
  return child
}

export async function loadSchedulerExecutionTickets(
  db: D1Database,
  businessDates: readonly string[],
): Promise<SchedulerExecutionTicketRow[]> {
  if (businessDates.length === 0) return []
  const placeholders = businessDates.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT *
      FROM scheduler_execution_tickets_v1
     WHERE business_date IN (${placeholders})
     ORDER BY updated_at DESC, ticket_id DESC
  `).bind(...businessDates).all<SchedulerExecutionTicketRow>()
  return result.results ?? []
}

export async function loadLatestSchedulerRootTickets(
  db: D1Database,
  businessDates: readonly string[],
): Promise<SchedulerExecutionTicketRow[]> {
  if (businessDates.length === 0) return []
  const placeholders = businessDates.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT * FROM (
      SELECT tickets.*,
             ROW_NUMBER() OVER (
               PARTITION BY scheduler_job_id, business_date
               ORDER BY updated_at DESC, ticket_id DESC
             ) AS ticket_rank
        FROM scheduler_execution_tickets_v1 tickets
       WHERE scheduler_job_id IS NOT NULL
         AND business_date IN (${placeholders})
    ) ranked
    WHERE ticket_rank=1
    ORDER BY updated_at DESC, ticket_id DESC
  `).bind(...businessDates).all<SchedulerExecutionTicketRow & { ticket_rank: number }>()
  return result.results ?? []
}
export function schedulerTicketStatusForRunLog(
  status: 'success' | 'error' | 'skipped' | 'triggered' | 'running',
): SchedulerExecutionTicketStatus {
  return status
}

export const SCHEDULER_TICKET_CONTRACT_ROOTS = MANIFEST_JOBS.length
