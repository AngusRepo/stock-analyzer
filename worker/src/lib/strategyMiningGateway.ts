import type { Bindings } from '../types'
import { normalizeSingleD1BatchStatement } from './d1BatchStatement'

const STRATEGY_MINING_TABLES = new Set([
  'strategy_mining_runs',
  'strategy_mining_candidates',
  'strategy_backtest_results',
  'active_strategy_backtest_results',
  'strategy_similarity_matrix',
  'strategy_promotion_ledger',
])
const STRATEGY_MINING_SQL_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE'])

const RUN_ID_RE = /^strategy-mining-[A-Za-z0-9._:-]{4,140}$/
const RUN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DISPATCH_TTL_SECONDS = 7 * 24 * 60 * 60

export function strategyMiningDispatchKey(runId: string): string {
  return `strategy-mining:dispatch:${runId}`
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  const length = Math.max(leftBytes.length, rightBytes.length)
  let mismatch = leftBytes.length ^ rightBytes.length
  for (let i = 0; i < length; i += 1) {
    mismatch |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0)
  }
  return mismatch === 0
}

function requireDedicatedToken(c: any) {
  const expected = String(c.env.STRATEGY_MINING_CALLBACK_TOKEN ?? '')
  const header = String(c.req.header('Authorization') ?? '')
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!expected || !provided || !constantTimeTextEqual(provided, expected)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

function normalizeStrategyMiningSql(raw: unknown, index: number): string {
  const sql = normalizeSingleD1BatchStatement(raw, index, STRATEGY_MINING_SQL_VERBS)
  if (sql.length > 12_000) throw new Error(`statement[${index}] exceeds 12000 characters`)
  const verb = /^\s*(select|insert|update)\b/i.exec(sql)?.[1]?.toLowerCase()
  if (!verb) throw new Error(`statement[${index}] must be SELECT, INSERT, or UPDATE`)

  if (/\bfrom\s+[`"\[]?[A-Za-z_][A-Za-z0-9_]*[`"\]]?(?:\s+(?:as\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s*,/i.test(sql)) {
    throw new Error(`statement[${index}] comma-separated table lists are not allowed`)
  }

  const tables = [...sql.matchAll(/\b(?:from|into|update|join)\s+[\x60"\[]?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map(match => match[1].toLowerCase())
  if (tables.length === 0) throw new Error(`statement[${index}] has no recognized table`)
  const rejected = tables.filter(table => !STRATEGY_MINING_TABLES.has(table))
  if (rejected.length > 0) {
    throw new Error(`statement[${index}] table is not allowed: ${[...new Set(rejected)].join(',')}`)
  }
  return sql
}

function normalizeParams(raw: unknown, index: number): unknown[] {
  if (!Array.isArray(raw)) return []
  if (raw.length > 64) throw new Error(`statement[${index}] has too many params`)
  for (const value of raw) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`statement[${index}] contains an invalid param type`)
    }
    if (typeof value === 'string' && value.length > 300_000) {
      throw new Error(`statement[${index}] contains an oversized string param`)
    }
  }
  return raw
}

export async function handleStrategyMiningD1Gateway(c: any) {
  const authError = requireDedicatedToken(c)
  if (authError) return authError

  const body = await c.req.json().catch(() => null) as any
  const rawStatements = Array.isArray(body?.statements) ? body.statements : []
  const requestedMax = Number(body?.max_statements ?? 100)
  const maxStatements = Math.max(1, Math.min(Number.isInteger(requestedMax) ? requestedMax : 100, 100))
  if (rawStatements.length === 0) return c.json({ error: 'statements must be a non-empty array' }, 400)
  if (rawStatements.length > maxStatements) {
    return c.json({ error: `too many statements: ${rawStatements.length} > ${maxStatements}` }, 400)
  }

  let statements: Array<{ sql: string; params: unknown[] }>
  try {
    statements = rawStatements.map((raw: any, index: number) => ({
      sql: normalizeStrategyMiningSql(raw?.sql, index),
      params: normalizeParams(raw?.params, index),
    }))
  } catch (error: any) {
    return c.json({ error: String(error?.message ?? error) }, 400)
  }

  const prepared = statements.map(statement => c.env.DB.prepare(statement.sql).bind(...statement.params))
  const started = Date.now()
  const results = await c.env.DB.batch(prepared)
  const changesTotal = results.reduce((sum: number, result: any) => {
    const meta = result?.meta ?? {}
    return sum + Number(meta.changes ?? meta.rows_written ?? 0)
  }, 0)

  return c.json({
    ok: true,
    total: statements.length,
    success_count: results.length,
    error_count: 0,
    changes_total: changesTotal,
    duration_ms: Date.now() - started,
    mode: 'strategy_mining_d1_gateway',
    results,
  })
}

function validateCallbackBody(body: any): string | null {
  const allowedKeys = new Set([
    'task', 'status', 'summary', 'duration_ms', 'error', 'run_id', 'run_date', 'metadata',
  ])
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'JSON object body is required'
  const unknownKeys = Object.keys(body).filter(key => !allowedKeys.has(key))
  if (unknownKeys.length > 0) return `unknown fields: ${unknownKeys.join(',')}`
  if (body.task !== 'monthly-strategy-mining') return 'task must be monthly-strategy-mining'
  if (!['success', 'error', 'skipped'].includes(String(body.status))) return 'status must be terminal'
  if (!RUN_ID_RE.test(String(body.run_id ?? ''))) return 'invalid run_id'
  if (!RUN_DATE_RE.test(String(body.run_date ?? ''))) return 'invalid run_date'
  if (typeof body.summary !== 'string' || body.summary.length > 1000) return 'invalid summary'
  if (!Number.isInteger(body.duration_ms) || body.duration_ms < 0 || body.duration_ms > 43_200_000) {
    return 'invalid duration_ms'
  }
  if (body.error != null && (typeof body.error !== 'string' || body.error.length > 2000)) {
    return 'invalid error'
  }
  if (body.metadata != null && (typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
    return 'invalid metadata'
  }
  return null
}

export async function handleStrategyMiningCallback(c: any) {
  const authError = requireDedicatedToken(c)
  if (authError) return authError

  const body = await c.req.json().catch(() => null) as any
  const validationError = validateCallbackBody(body)
  if (validationError) return c.json({ error: validationError }, 400)

  const key = strategyMiningDispatchKey(body.run_id)
  const dispatch = await c.env.KV.get(key, 'json') as Record<string, any> | null
  if (!dispatch || dispatch.run_id !== body.run_id || dispatch.run_date !== body.run_date) {
    return c.json({ error: 'unknown or mismatched strategy-mining dispatch' }, 409)
  }
  if (dispatch.terminal_status) {
    if (dispatch.terminal_status === body.status) {
      return c.json({ ok: true, ignored: true, reason: 'duplicate_terminal_callback', run_id: body.run_id })
    }
    return c.json({ error: 'conflicting terminal callback' }, 409)
  }

  const { logSchedulerResult } = await import('./schedulerRunLogger')
  await logSchedulerResult(c.env.KV, body.task, {
    status: body.status,
    summary: body.summary,
    duration_ms: body.duration_ms,
    error: body.error,
    run_id: body.run_id,
    run_date: body.run_date,
    strict: true,
  }, c.env as Bindings)

  await c.env.KV.put(key, JSON.stringify({
    ...dispatch,
    status: 'terminal',
    terminal_status: body.status,
    terminal_at: new Date().toISOString(),
  }), { expirationTtl: DISPATCH_TTL_SECONDS })

  if (body.status === 'success' && c.env.ARTIFACTS) {
    c.executionCtx.waitUntil((async () => {
      try {
        const { recordSchedulerRunReportArtifact } = await import('./datasetSnapshots')
        await recordSchedulerRunReportArtifact(c.env, {
          task: body.task,
          status: body.status,
          businessDate: body.run_date,
          runId: body.run_id,
          summary: body.summary,
          durationMs: body.duration_ms,
        })
      } catch (error) {
        console.warn('[strategy-mining-callback] report artifact failed:', error)
      }
    })())
  }

  console.log(`[strategy-mining-callback] ${body.status} run_id=${body.run_id}`)
  return c.json({ ok: true, task: body.task, status: body.status, run_id: body.run_id })
}
