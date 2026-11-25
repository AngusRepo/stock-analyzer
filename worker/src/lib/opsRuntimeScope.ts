import { AsyncLocalStorage } from 'node:async_hooks'
import type { Bindings } from '../types'

/**
 * Request-local runtime context for observability only: the Worker env (so helpers called without
 * env, such as logSchedulerRunResult at ~119 call sites, can still alert and record stage state)
 * and the scheduler ticket being executed (L1 correlation id). Never used for business decisions.
 * Kept out of the native Paper bundle: no bundle file imports this module.
 */
export interface OpsRuntimeTicket {
  task: string
  ticketId: string
  rootTicketId: string
  attempt: number
  businessDate?: string
}

interface OpsRuntimeStore {
  env: Bindings
  ticket?: OpsRuntimeTicket
}

const storage = new AsyncLocalStorage<OpsRuntimeStore>()

/** Enter the scope for one entrypoint invocation (fetch / scheduled / one queue message). Nested calls reuse it. */
export function withOpsRuntimeScope<T>(env: Bindings, execute: () => T): T {
  if (storage.getStore()) return execute()
  return storage.run({ env }, execute)
}

export function opsRuntimeEnv(): Bindings | undefined {
  return storage.getStore()?.env
}

/** Record the admitted scheduler ticket for this request (first admission wins). */
export function setOpsRuntimeTicket(ticket: OpsRuntimeTicket): void {
  const store = storage.getStore()
  if (!store || store.ticket) return
  if (!ticket.ticketId || !ticket.rootTicketId) return
  store.ticket = { ...ticket, attempt: Number.isSafeInteger(ticket.attempt) ? ticket.attempt : 0 }
}

/**
 * Queue-driven stages (event-driven screener / pipeline dispatch) run without an admitted ticket.
 * Bind the business date's latest physical root (default: evening-chain, from the ops control plane) so the correlation header
 * still reaches ml-controller and its Cloud Run Jobs. One indexed read (idx_..._job_date); no-op
 * when a ticket is already in scope or no scope exists; never throws.
 */
export async function bindOpsRuntimeRootTicket(env: Bindings, businessDate: string,
  schedulerJobId = 'evening-chain'): Promise<void> {
  const store = storage.getStore()
  if (!store || store.ticket || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return
  try {
    const [{ loadLatestSchedulerRootTicket }, { databaseForDataDomain }] = await Promise.all([
      import('./schedulerExecutionTickets'), import('./dataDomainRegistry')])
    const root = await loadLatestSchedulerRootTicket(databaseForDataDomain(env, 'ops'), { schedulerJobId, businessDate })
    if (!root?.ticket_id) return
    setOpsRuntimeTicket({ task: schedulerJobId, ticketId: root.ticket_id,
      rootTicketId: root.root_ticket_id || root.ticket_id, attempt: Number(root.attempt_count ?? 0), businessDate })
  } catch (error) {
    console.warn(`[opsRuntimeScope] root ticket lookup failed (ignored) date=${businessDate}:`,
      error instanceof Error ? error.message : String(error))
  }
}

export function opsRuntimeTicket(): OpsRuntimeTicket | undefined {
  return storage.getStore()?.ticket
}

const ROOT_TICKET_ID = /^[A-Za-z0-9:._-]{1,200}$/

/** Header carrying the L1 correlation id to ml-controller; empty when no ticket is in scope. */
export function opsCorrelationHeaders(): Record<string, string> {
  const root = storage.getStore()?.ticket?.rootTicketId
  return root && ROOT_TICKET_ID.test(root) ? { 'X-Root-Ticket-Id': root } : {}
}
