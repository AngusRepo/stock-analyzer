import type { Bindings } from '../types'
import { createHash } from 'node:crypto'
import { paperExecutionNow, recordPaperExecutionFailure, advancePaperExecutionClock } from '../lib/paperExecutionScope'
import { runNativePaperExecutionFrame, type NativePaperStage } from '../lib/nativePaperExecutionFrame'

export type PaperBridge = (op: string, payload: Record<string, unknown>) => Promise<any>
export interface SealedPaperFrame {
  stage: NativePaperStage
  observed_at: string
  input_id: string
  cron?: string
}

/** No REST adapter, inherited environment, production DB or credential access. */
export function sealedPaperBindings(bridge: PaperBridge, variables: Record<string, string>, hostClock?: () => number) {
  const outstanding = new Set<Promise<unknown>>()
  const failures: string[] = []
  const invalid = (reason: string): never => {
    failures.push(reason)
    recordPaperExecutionFailure(reason)
    throw new Error('sealed_paper_' + reason)
  }
  const call: PaperBridge = (op, payload) => {
    const pending = Promise.resolve().then(() => bridge(op, payload)).then(result => {
      if (hostClock) advancePaperExecutionClock(hostClock())
      return result
    }).catch(error => {
      failures.push(op)
      recordPaperExecutionFailure('private_bridge:' + op)
      throw error
    })
    outstanding.add(pending)
    // Attach both handlers so a native fire-and-forget write cannot become an
    // unhandled rejection, disappear at process exit, or escape the transaction.
    pending.then(() => outstanding.delete(pending), () => outstanding.delete(pending))
    return pending
  }
  const drain = async () => {
    do {
      await Promise.allSettled([...outstanding])
      await Promise.resolve()
    } while (outstanding.size)
    if (failures.length) throw new Error('sealed_paper_pending_operation_failed:' + failures.join(','))
  }
  class Statement implements D1PreparedStatement {
    constructor(readonly domain: string, readonly sql: string, readonly args: unknown[] = []) {}
    bind(...args: unknown[]) { return new Statement(this.domain, this.sql, args) }
    async all<T>() { return call('sql', { domain: this.domain, sql: this.sql, args: this.args }) as Promise<D1Result<T>> }
    async run<T>() { return this.all<T>() }
    async first<T>(column?: string): Promise<T | null> {
      const row = (await this.all<Record<string, unknown>>()).results[0]
      return (column ? row?.[column] ?? null : row ?? null) as T | null
    }
    async raw<T>() { return (await this.all<Record<string, unknown>>()).results.map(Object.values) as T[] }
  }
  const createDatabase = (domain: string): D1Database => ({
    prepare: sql => new Statement(domain, sql),
    batch: async statements => call('batch', { statements: statements.map(s => {
      if (!(s instanceof Statement)) throw new Error('sealed_paper_foreign_statement')
      return { domain: s.domain, sql: s.sql, args: s.args }
    }) }),
    exec: async () => { recordPaperExecutionFailure('unprepared_sql'); throw new Error('sealed_paper_exec_forbidden') },
  })
  const databases = Object.freeze(Object.fromEntries(
    ['core', 'market', 'learning', 'ops', 'execution', 'paper', 'research'].map(key => [key, createDatabase(key)])))
  const kv: KVNamespace = {
    get: async (key: string, options?: any) => {
      const type = typeof options === 'string' ? options : options?.type ?? 'text'
      const value = await call('kv_get', { key, now_ms: paperExecutionNow() })
      if (value == null) return null
      if (type === 'json') {
        try { return JSON.parse(value) } catch { return invalid('kv_json_invalid') }
      }
      if (type === 'text') return value
      if (type === 'arrayBuffer') return new TextEncoder().encode(value).buffer
      if (type === 'stream') return new Response(value).body
      return invalid('kv_type_invalid')
    },
    put: async (key, value, options = {}) => {
      if (typeof value !== 'string') return invalid('kv_nontext_unsupported')
      await call('kv_put', { key, value, options, now_ms: paperExecutionNow() })
    },
    delete: async key => { await call('kv_delete', { key }) },
    list: async (options = {}) => call('kv_list', { ...options, now_ms: paperExecutionNow() }),
  }
  const artifacts = {
    put: async (key: string, value: string) => {
      if (typeof value !== 'string') return invalid('artifact_nontext_unsupported')
      await call('artifact_put', { key, value })
      return { key }
    },
    get: async (key: string) => {
      const value = await call('artifact_get', { key })
      return value == null ? null : { text: async () => value, json: async () => {
        try { return JSON.parse(value) } catch { return invalid('artifact_json_invalid') }
      },
        arrayBuffer: async () => new TextEncoder().encode(value).buffer }
    },
  }
  const scalar: Record<string, string> = {}
  for (const [key, value] of Object.entries(variables)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error('sealed_paper_variable_invalid')
    if (/(TOKEN|SECRET|API_KEY|PASSWORD|WEBHOOK)/.test(key) && value && value !== '__SEALED_CREDENTIAL__') {
      throw new Error('sealed_paper_credentials_forbidden')
    }
    scalar[key] = value
  }
  const forbidden = (name: string) => () => {
    recordPaperExecutionFailure('capability:' + name)
    throw new Error('sealed_paper_capability_forbidden:' + name)
  }
  const queue = { send: forbidden('queue'), sendBatch: forbidden('queue') }
  const environment = Object.freeze({ ...scalar, DB: databases.core, CORE_DB: databases.core, MARKET_DB: databases.market,
    LEARNING_DB: databases.learning, OPS_DB: databases.ops, EXECUTION_DB: databases.execution,
    PAPER_DB: databases.paper, RESEARCH_DB: databases.research,
    KV: kv, ARTIFACTS: artifacts, UPDATE_QUEUE: queue, NEWS_QUEUE: queue, ML_QUEUE: queue,
    AI: { run: (...args: unknown[]) => call('frozen_ai', { args }) },
  }) as unknown as Bindings
  const fetchFrozen = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    // Auth is deliberately not serialised. These are request identities, never
    // an outbound network instruction; only the sealed transport table can reply.
    const packet = await call('frozen_fetch', { url: req.url, method: req.method,
      body: ['GET', 'HEAD'].includes(req.method) ? '' : await req.text() })
    return new Response(packet.body, { status: packet.status, headers: packet.headers })
  }
  return { environment, databases, fetchFrozen, call, drain }
}

export async function runSealedPaperFrames(bridge: PaperBridge, input: {
  account_id: number; variables: Record<string, string>; frames: SealedPaperFrame[];
}, hostClock?: () => number) {
  if (!input.frames.length) throw new Error('sealed_paper_frames_missing')
  const ports = sealedPaperBindings(bridge, input.variables, hostClock)
  const results = []
  let previousTime = -Infinity
  for (const frame of input.frames) {
    const nowMs = Date.parse(frame.observed_at)
    if (!frame.input_id || !Number.isFinite(nowMs) || nowMs < previousTime) {
      throw new Error('sealed_paper_frame_identity_invalid')
    }
    previousTime = nowMs
    await ports.call('frame_input', { ...frame, now_ms: nowMs })
    let identitySequence = 0
    results.push(await runNativePaperExecutionFrame({ ...ports, accountId: input.account_id, nowMs: hostClock?.() ?? nowMs,
      executionUUID: () => createHash('sha256').update(JSON.stringify([input.account_id, frame.input_id, ++identitySequence])).digest('hex'),
      transaction: async execute => {
        await ports.call('frame_begin', {})
        try {
          const result = await execute()
          await ports.drain()
          await ports.call('frame_commit', {})
          return result
        } catch (error) { await ports.call('frame_rollback', {}); throw error }
      },
    }, frame.stage, { cron: frame.cron, scheduledAt: frame.observed_at }))
  }
  return { frames: results, production_effect: false, session_complete: false, nav_maturity_credit: 0 }
}
