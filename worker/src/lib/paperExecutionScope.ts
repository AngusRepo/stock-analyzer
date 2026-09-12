import { AsyncLocalStorage } from 'node:async_hooks'
import type { Bindings } from '../types'

/** Request-local ports. No process-global account, clock or fetch overrides. */
export interface PaperExecutionPorts {
  environment: Bindings
  accountId: number
  nowMs: number
  executionUUID?: () => string
  databases: Readonly<Record<string, D1Database>>
  fetchFrozen: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

interface Scope extends PaperExecutionPorts {
  violations: string[]
  notifications: Array<{ channel: string; message: string }>
}

const storage = new AsyncLocalStorage<Scope>()

export function recordPaperExecutionFailure(reason: string): void {
  storage.getStore()?.violations.push(reason)
}

export const paperExecutionNow = (): number => storage.getStore()?.nowMs ?? Date.now()
/** Advance only from the trusted private host's sealed input clock. */
export function advancePaperExecutionClock(nowMs: number): void {
  const scope = storage.getStore()
  if (!scope) return
  if (!Number.isFinite(nowMs) || nowMs < scope.nowMs) {
    scope.violations.push('clock_regression')
    throw new Error('paper_execution_clock_regression')
  }
  scope.nowMs = nowMs
}
export const paperExecutionDate = (): Date => new Date(paperExecutionNow())
export const paperAccountId = (): number => storage.getStore()?.accountId ?? 1
export const scopedPaperAccountId = (): number | null => storage.getStore()?.accountId ?? null
export const paperExecutionUUID = (): string => storage.getStore()?.executionUUID?.() ?? crypto.randomUUID()

export function scopedPaperDatabase(env: unknown, domain: string): D1Database | undefined {
  const scope = storage.getStore()
  if (!scope) return undefined
  if (env !== scope.environment || !scope.databases[domain]) {
    scope.violations.push('unscoped_database:' + domain)
    throw new Error('paper_execution_unscoped_database:' + domain)
  }
  return scope.databases[domain]
}

export async function paperExecutionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const scope = storage.getStore()
  if (!scope) return fetch(input, init)
  try {
    return await scope.fetchFrozen(input, init)
  } catch (error) {
    // Native helpers may catch transport errors. Do not let that turn an
    // incomplete sealed input into a successful zero-fill session receipt.
    scope.violations.push('frozen_transport_failed')
    throw error
  }
}

export function capturePaperNotification(channel: string, message: string): boolean {
  const scope = storage.getStore()
  if (!scope) return false
  scope.notifications.push({ channel, message })
  return true
}

export async function withPaperExecutionScope<T>(ports: PaperExecutionPorts, execute: () => Promise<T>) {
  if (storage.getStore()) throw new Error('paper_execution_nested_scope_forbidden')
  if (!Number.isSafeInteger(ports.accountId) || ports.accountId < 1 || !Number.isFinite(ports.nowMs)) {
    throw new Error('paper_execution_scope_identity_invalid')
  }
  const scope: Scope = { ...ports, violations: [], notifications: [] }
  return storage.run(scope, async () => {
    const result = await execute()
    if (scope.violations.length) throw new Error('paper_execution_scope_incomplete:' + scope.violations.join(','))
    return { result, notifications: scope.notifications, production_effect: false as const }
  })
}
