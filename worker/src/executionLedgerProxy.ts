type ExecutionLedgerBindings = {
  EXECUTION_DB: D1Database
  EXECUTION_LEDGER_TOKEN: string
  EXECUTION_LEDGER_INSTANCE_ID: string
}

type QueryStatement = {
  sql: string
  params: unknown[]
}

const ALLOWED_TABLES = new Set([
  'execution_database_identity',
  'broker_execution_intents',
  'broker_execution_legs',
  'broker_execution_events',
  'execution_control_state',
  'execution_risk_decisions',
  'execution_reconciliation_runs',
  'execution_reconciliation_discrepancies',
])

const ALLOWED_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE'])
const READ_ONLY_TABLES = new Set([
  'execution_database_identity',
  'execution_control_state',
])
const DENIED_SQL = /\b(?:ATTACH|DETACH|PRAGMA|CREATE|ALTER|DROP|DELETE|REPLACE|VACUUM|REINDEX|LOAD_EXTENSION|SQLITE_[A-Z0-9_]*)\b/i
const COMMA_JOIN_SQL = /\bFROM\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s*,/i
const encoder = new TextEncoder()
const decoder = new TextDecoder()

class ProxyContractError extends Error {}

async function assertExecutionDatabaseIdentity(db: D1Database, expectedInstanceId: string): Promise<void> {
  const identity = await db.prepare(`
    SELECT purpose, schema_version, instance_id
      FROM execution_database_identity
     WHERE identity_key='primary'
     LIMIT 1
  `).first<{ purpose?: string; schema_version?: string; instance_id?: string }>()
  if (
    identity?.purpose !== 'real_trading_execution_only'
    || identity?.schema_version !== 'stockvision-execution-ledger-v1'
    || !expectedInstanceId
    || expectedInstanceId === 'UNPROVISIONED'
    || identity?.instance_id !== expectedInstanceId
  ) {
    throw new Error('execution_database_identity_mismatch')
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function secretMatches(actual: string, expected: string): Promise<boolean> {
  if (!actual || !expected) return false
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(actualHash)
  const right = new Uint8Array(expectedHash)
  let mismatch = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return mismatch === 0
}

async function tokenMatches(authorization: string | null, expected: string): Promise<boolean> {
  const actual = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  return secretMatches(actual, expected)
}

function normalizeStatement(raw: unknown, index: number): QueryStatement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProxyContractError(`statement_${index}_invalid`)
  }
  const candidate = raw as Record<string, unknown>
  const sql = typeof candidate.sql === 'string' ? candidate.sql.trim() : ''
  if (!sql || sql.length > 100_000) throw new ProxyContractError(`statement_${index}_sql_invalid`)
  if (
    sql.includes(';')
    || sql.includes('--')
    || sql.includes('/*')
    || sql.includes('"')
    || sql.includes('`')
    || sql.includes('[')
    || sql.includes(']')
    || DENIED_SQL.test(sql)
    || COMMA_JOIN_SQL.test(sql)
  ) {
    throw new ProxyContractError(`statement_${index}_sql_denied`)
  }
  const verb = sql.split(/\s+/, 1)[0]?.toUpperCase()
  if (!ALLOWED_VERBS.has(verb)) throw new ProxyContractError(`statement_${index}_verb_denied`)

  const tables = new Set<string>()
  const tablePattern = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?!SET\b)([A-Za-z_][A-Za-z0-9_]*)/gi
  for (const match of sql.matchAll(tablePattern)) tables.add(String(match[1]).toLowerCase())
  if (!tables.size || [...tables].some((table) => !ALLOWED_TABLES.has(table))) {
    throw new ProxyContractError(`statement_${index}_table_denied`)
  }
  if (verb !== 'SELECT' && [...tables].some((table) => READ_ONLY_TABLES.has(table))) {
    throw new ProxyContractError(`statement_${index}_table_read_only`)
  }

  const params = Array.isArray(candidate.params) ? candidate.params : []
  if (params.length > 100) throw new ProxyContractError(`statement_${index}_params_exceeded`)
  if (params.some((value) => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) {
    throw new ProxyContractError(`statement_${index}_param_type_denied`)
  }
  return { sql, params }
}

function parseStatements(body: unknown): QueryStatement[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProxyContractError('request_body_invalid')
  }
  const value = body as Record<string, unknown>
  const rawStatements = Array.isArray(value.batch)
    ? value.batch
    : [{ sql: value.sql, params: value.params }]
  if (!rawStatements.length || rawStatements.length > 100) {
    throw new ProxyContractError('statement_count_invalid')
  }
  return rawStatements.map(normalizeStatement)
}

export async function handleExecutionLedgerProxy(
  request: Request,
  env: ExecutionLedgerBindings,
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'POST' || url.pathname !== '/v1/d1/query') {
    return json({ success: false, error: 'not_found' }, 404)
  }
  if (!await tokenMatches(request.headers.get('Authorization'), env.EXECUTION_LEDGER_TOKEN)) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  if (!await secretMatches(
    request.headers.get('X-Execution-Ledger-Instance-ID') ?? '',
    env.EXECUTION_LEDGER_INSTANCE_ID,
  )) {
    return json({ success: false, error: 'execution_ledger_instance_mismatch' }, 403)
  }
  const contentLengthHeader = request.headers.get('Content-Length')
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader)
  if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength < 0)) {
    return json({ success: false, error: 'content_length_invalid' }, 400)
  }
  if (contentLength !== null && contentLength > 512_000) {
    return json({ success: false, error: 'request_too_large' }, 413)
  }
  let statements: QueryStatement[]
  try {
    const body = await request.arrayBuffer()
    if (body.byteLength > 512_000) {
      return json({ success: false, error: 'request_too_large' }, 413)
    }
    statements = parseStatements(JSON.parse(decoder.decode(body)))
  } catch (error) {
    const reason = error instanceof ProxyContractError ? error.message : 'request_json_invalid'
    return json({ success: false, error: reason }, 400)
  }
  try {
    await assertExecutionDatabaseIdentity(env.EXECUTION_DB, env.EXECUTION_LEDGER_INSTANCE_ID)
    const prepared = statements.map((statement) =>
      env.EXECUTION_DB.prepare(statement.sql).bind(...statement.params)
    )
    const results = await env.EXECUTION_DB.batch(prepared)
    if (results.length !== statements.length || results.some((result) => result.success === false)) {
      throw new Error('execution_d1_batch_unproven')
    }
    return json({
      success: true,
      result: results.map((result) => ({
        success: result.success !== false,
        results: result.results ?? [],
        meta: result.meta ?? {},
      })),
    })
  } catch (error) {
    console.error('[execution-ledger-proxy] D1 operation failed', error instanceof Error ? error.name : 'Error')
    return json({ success: false, error: 'execution_ledger_unavailable' }, 503)
  }
}

export default {
  fetch(request: Request, env: ExecutionLedgerBindings): Promise<Response> {
    return handleExecutionLedgerProxy(request, env)
  },
}
