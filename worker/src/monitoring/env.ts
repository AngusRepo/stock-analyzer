import type { AuthEnv } from './auth'
import { ReadLedger, readOnlyD1 } from './readOnlyD1'

/** stockvision-monitoring bindings (worker/wrangler.monitoring.toml). All D1 access goes through readOnlyD1. */
export type MonitoringEnv = AuthEnv & {
  OPS_DB: D1Database
  MARKET_DB: D1Database
  LEARNING_DB: D1Database
  PAPER_DB: D1Database
  EXECUTION_DB: D1Database
  CORE_DB?: D1Database
  RESEARCH_DB?: D1Database
  /** Legacy stockvision-db; capacity size probe only. */
  DB?: D1Database
  /** Main Worker KV; read only for holiday:* and the TWSE closure caches. */
  KV: KVNamespace
  /** Optional override of the contract's 18:30 (Taiwan): a trading day with no chain row after it is a missed chain. */
  CHAIN_ROOT_EXPECTED_BY_TW?: string
  /** Route cache and memo store on workers.dev (kvCache.ts); never exposed to routes. */
  MONITORING_CACHE?: KVNamespace
  /** Set per request by the handler when a cache is available; absent = every read goes to its source. */
  MEMO?: Memo
}

/** Values a later request reuses instead of reading them again (cache entries next to the route cache). */
export type Memo = {
  get<T>(key: string): Promise<T | null>
  put(key: string, value: unknown, ttlS: number): Promise<void>
}

export async function memoized<T>(memo: Memo | undefined, key: string, ttlS: number, compute: () => Promise<T>): Promise<T> {
  if (!memo) return compute()
  const hit = await memo.get<{ value: T }>(key)
  if (hit) return hit.value
  const value = await compute()
  await memo.put(key, { value }, ttlS)
  return value
}

export const D1_BINDINGS = ['DB', 'CORE_DB', 'MARKET_DB', 'LEARNING_DB', 'OPS_DB', 'EXECUTION_DB', 'PAPER_DB', 'RESEARCH_DB'] as const

/** Same bindings, every D1 wrapped read-only and accounted in one ledger; KV exposes get() only. */
export function readOnlyEnv(env: MonitoringEnv, ledger: ReadLedger): MonitoringEnv {
  const out: Record<string, unknown> = { ...env }
  delete out.MONITORING_CACHE
  for (const name of D1_BINDINGS) {
    const db = env[name]
    if (db) out[name] = readOnlyD1(db, name, ledger)
  }
  const kv = env.KV
  out.KV = { get: (...args: unknown[]) => (kv.get as (...a: unknown[]) => unknown)(...args) } as unknown as KVNamespace
  return out as MonitoringEnv
}

export const TW_OFFSET_MS = 8 * 3600_000

export function twDate(nowMs: number): string {
  return new Date(nowMs + TW_OFFSET_MS).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export function isIsoDate(value: string | null | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value)
}
