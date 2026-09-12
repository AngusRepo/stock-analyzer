import type { Bindings, UpdateQueueMsg } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import {
  admitSchedulerChildTicket,
  admitSchedulerExecutionTicket,
  claimSchedulerExecutionTicket,
  loadLatestSchedulerRootTicket,
  markSchedulerExecutionTicketQueued,
  schedulerTicketStatusForRunLog,
  updateSchedulerExecutionTicket,
  type SchedulerExecutionTicketRow,
} from './schedulerExecutionTickets'
import { classifySchedulerRunSummary, logSchedulerResult } from './schedulerRunLogger'

const SNAPSHOT_CONTINUATION_ORIGIN = 'dataset_snapshot_ready'

type ReadySnapshotRow = {
  snapshot_id?: string | null
  business_date?: string | null
  kind?: string | null
  access_tier?: string | null
  status?: string | null
}

export function parseBacktestSnapshotId(summary: string): string | null {
  const value = summary.match(/(?:^|\s)backtest=([^\s]+)/i)?.[1]?.trim() ?? ''
  return value && !['none', 'null', 'undefined'].includes(value.toLowerCase()) ? value : null
}

async function requireReadyBacktestSnapshot(
  env: Bindings,
  businessDate: string,
  snapshotId: string,
): Promise<ReadySnapshotRow> {
  const row = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT snapshot_id, business_date, kind, access_tier, status
      FROM dataset_snapshots
     WHERE snapshot_id=? AND business_date=?
       AND kind='backtest_dataset' AND access_tier='compute' AND status='ready'
     LIMIT 1
  `).bind(snapshotId, businessDate).first<ReadySnapshotRow>()
  if (!row) {
    throw new Error(`active8_snapshot_ready_receipt_missing:${businessDate}:${snapshotId}`)
  }
  return row
}

export async function enqueueActive8AfterDatasetSnapshot(
  env: Bindings,
  input: { businessDate: string; snapshotRunId: string; summary: string },
): Promise<{ queued: boolean; ticketId: string; reason: string; snapshotId: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new Error(`active8_snapshot_continuation_date_invalid:${input.businessDate}`)
  }
  const snapshotId = parseBacktestSnapshotId(input.summary)
  if (!snapshotId) throw new Error('active8_snapshot_continuation_snapshot_id_missing')
  await requireReadyBacktestSnapshot(env, input.businessDate, snapshotId)

  const opsDb = databaseForDataDomain(env, 'ops')
  let root = await loadLatestSchedulerRootTicket(opsDb, {
    schedulerJobId: 'evening-chain',
    businessDate: input.businessDate,
  })
  let snapshotTicket = root
  if (!root) {
    const manualRoot = await admitSchedulerExecutionTicket(opsDb, {
      identity: { schedulerJobId: null, scheduledAt: null, ticketKind: 'manual' },
      task: 'dataset-snapshot-export',
      requestedRunDate: input.businessDate,
      proposedRunId: input.snapshotRunId,
      metadata: { origin: SNAPSHOT_CONTINUATION_ORIGIN, snapshot_id: snapshotId },
    })
    root = manualRoot.ticket
    snapshotTicket = root
    await updateSchedulerExecutionTicket(opsDb, {
      ticketId: root.ticket_id,
      runId: root.run_id,
      status: 'success',
      authority: 'logical_child',
      summary: `detached dataset snapshot ready snapshot_id=${snapshotId}`,
    })
  } else {
    snapshotTicket = await admitSchedulerChildTicket(opsDb, {
      rootTicketId: root.root_ticket_id,
      parentTicketId: root.ticket_id,
      childKey: `dataset-snapshot-export:${snapshotId}`,
      task: 'dataset-snapshot-export',
      businessDate: input.businessDate,
      runId: input.snapshotRunId,
      metadata: { origin: SNAPSHOT_CONTINUATION_ORIGIN, snapshot_id: snapshotId },
    })
    await updateSchedulerExecutionTicket(opsDb, {
      ticketId: snapshotTicket.ticket_id,
      runId: snapshotTicket.run_id,
      status: 'success',
      authority: 'logical_child',
      summary: `detached dataset snapshot ready snapshot_id=${snapshotId}`,
    })
  }

  const childRunId = `${input.snapshotRunId}:active8-oof-daily`
  const child = await admitSchedulerChildTicket(opsDb, {
    rootTicketId: root.root_ticket_id,
    parentTicketId: snapshotTicket.ticket_id,
    childKey: `dataset-snapshot-ready:active8-oof-daily:${snapshotId}`,
    task: 'active8-oof-daily',
    businessDate: input.businessDate,
    runId: childRunId,
    metadata: {
      origin: SNAPSHOT_CONTINUATION_ORIGIN,
      snapshot_id: snapshotId,
      snapshot_run_id: input.snapshotRunId,
      active8_callback_run_id: `active8-oof-daily:${input.businessDate}:resolve-after-prep`,
    },
  })
  if (['queued', 'running', 'triggered', 'success', 'skipped'].includes(child.status)) {
    return { queued: false, ticketId: child.ticket_id, reason: `duplicate_${child.status}`, snapshotId }
  }
  if ((child.status === 'error' || child.status === 'blocked') && child.attempt_count >= 3) {
    return { queued: false, ticketId: child.ticket_id, reason: 'attempt_limit', snapshotId }
  }

  const message: UpdateQueueMsg = {
    type: 'active8_oof_after_snapshot',
    cursor: 0,
    triggerTime: input.businessDate,
    runId: child.run_id,
    schedulerTicketId: child.ticket_id,
    active8SnapshotId: snapshotId,
  }
  await env.UPDATE_QUEUE.send(message)
  if (child.status === 'accepted') {
    await markSchedulerExecutionTicketQueued(opsDb, {
      ticketId: child.ticket_id,
      runId: child.run_id,
      summary: `snapshot-ready continuation queued snapshot_id=${snapshotId}`,
    })
  }
  return { queued: true, ticketId: child.ticket_id, reason: 'queued', snapshotId }
}

export async function processActive8AfterDatasetSnapshot(
  msg: UpdateQueueMsg,
  env: Bindings,
): Promise<void> {
  const businessDate = String(msg.triggerTime ?? '').slice(0, 10)
  const snapshotId = String(msg.active8SnapshotId ?? '').trim()
  const ticketId = String(msg.schedulerTicketId ?? '').trim()
  const runId = String(msg.runId ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || !snapshotId || !ticketId || !runId) {
    throw new Error('active8_snapshot_continuation_identity_incomplete')
  }
  const opsDb = databaseForDataDomain(env, 'ops')
  const claim = await claimSchedulerExecutionTicket(opsDb, { ticketId, runId })
  if (!claim.shouldExecute) return

  try {
    await requireReadyBacktestSnapshot(env, businessDate, snapshotId)
    const { runActive8OofLifecycle } = await import('./controllerResearchWorkflows')
    const summary = await runActive8OofLifecycle(env, businessDate, 'daily', {
      schedulerTicketId: ticketId,
      schedulerRunId: runId,
    })
    const status = classifySchedulerRunSummary(summary)
    await updateSchedulerExecutionTicket(opsDb, {
      ticketId,
      runId,
      status: schedulerTicketStatusForRunLog(status),
      authority: 'durable_queue',
      summary,
    })
    await logSchedulerResult(env.KV, 'active8-oof-daily', {
      status,
      summary,
      duration_ms: 0,
      run_id: runId,
      run_date: businessDate,
    }, env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateSchedulerExecutionTicket(opsDb, {
      ticketId,
      runId,
      status: 'error',
      authority: 'durable_queue',
      summary: message,
      error: message,
    })
    throw error
  }
}

export async function settleActive8SnapshotContinuationTicket(
  env: Bindings,
  input: {
    businessDate: string
    callbackRunId: string
    status: 'success' | 'error' | 'skipped'
    summary: string
    error?: string
    schedulerTicketId?: string
    schedulerRunId?: string
  },
): Promise<boolean> {
  const opsDb = databaseForDataDomain(env, 'ops')
  const ticketId = String(input.schedulerTicketId ?? '').trim()
  const runId = String(input.schedulerRunId ?? '').trim()
  if (Boolean(ticketId) !== Boolean(runId)) throw new Error('active8_snapshot_callback_ticket_identity_incomplete')
  const identityClause = ticketId ? ' AND ticket_id=? AND run_id=?' : ''
  const matches = await opsDb.prepare(`
    SELECT * FROM scheduler_execution_tickets_v1
     WHERE task='active8-oof-daily' AND business_date=? AND ticket_kind='logical_child'
       AND json_extract(metadata_json, '$.origin')=?
       AND json_extract(metadata_json, '$.active8_callback_run_id')=?${identityClause}
     LIMIT 2
  `).bind(input.businessDate, SNAPSHOT_CONTINUATION_ORIGIN, input.callbackRunId,
    ...(ticketId ? [ticketId, runId] : [])).all<SchedulerExecutionTicketRow>()
  // Old callbacks without ticket identity remain usable only when unambiguous.
  // A same-day callback run ID is shared by distinct snapshot deliveries.
  if ((matches.results ?? []).length > 1) throw new Error('active8_snapshot_callback_ticket_ambiguous')
  const ticket = matches.results?.[0]
  if (!ticket) return false
  const metadata = JSON.parse(ticket.metadata_json || '{}') as Record<string, unknown>
  if (String(metadata.active8_callback_run_id ?? '') !== input.callbackRunId) return false
  const terminal = ['success', 'error', 'skipped', 'blocked'].includes(ticket.status)
  if (terminal && ticket.status !== input.status) return false
  if (!terminal) {
    await updateSchedulerExecutionTicket(opsDb, {
      ticketId: ticket.ticket_id,
      runId: ticket.run_id,
      status: input.status,
      authority: 'logical_child',
      summary: input.summary,
      error: input.error,
    })
  }
  // The callback may have settled this exact child already, or a previous
  // delivery may have stopped after its commit. Child completion is not root
  // or KV closure; reconcile those again without rewriting the terminal child.
  const root = await loadLatestSchedulerRootTicket(opsDb, {
    schedulerJobId: 'evening-chain', businessDate: input.businessDate,
  })
  if (root && root.ticket_id !== ticket.root_ticket_id) return true
  const { closeEveningChainRootIfComplete } = await import('./eveningChainRootClosure')
  const closure = await closeEveningChainRootIfComplete(opsDb, {
    businessDate: input.businessDate,
  })
  if (closure.status === 'closed_success' || closure.status === 'closed_error') {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: closure.status === 'closed_success' ? 'success' : 'error',
      summary: closure.summary,
      error: closure.blockers.length ? closure.blockers.join(',') : undefined,
      duration_ms: 0,
      run_id: closure.canonical_run_id ?? input.callbackRunId,
      run_date: input.businessDate,
      strict: true,
    }, env)
  }
  return true
}
