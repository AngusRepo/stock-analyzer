/** Read-only D1 access for the monitoring Worker.
 * Every statement must be a single SELECT, WITH ... SELECT or EXPLAIN; anything else is refused before it
 * reaches D1. Results that report a write (rows_written, changes, changed_db) fail as a second guard.
 * Each binding is wrapped with one ReadLedger per request, so the response can carry D1's own rows_read. */

export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadOnlyViolation'
  }
}

export type ExecutedQuery = { db: string; sql: string; params: unknown[]; rowsRead: number }

export class ReadLedger {
  rowsRead = 0
  queries: ExecutedQuery[] = []
  constructor(readonly onQuery?: (query: ExecutedQuery) => void) {}
  record(query: ExecutedQuery): void {
    this.rowsRead += query.rowsRead
    this.queries.push(query)
    this.onQuery?.(query)
  }
}

// Statement keywords that change data, schema or connection state. REPLACE alone is the replace()
// function, so only REPLACE INTO counts; INSERT OR REPLACE is caught by INSERT.
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|UPSERT|REPLACE\s+INTO|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|RETURNING|TRIGGER)\b/i

/** SQL with comments, string literals and quoted identifiers blanked out, so keywords inside them do not count. */
function codeOnly(sql: string): string {
  let out = ''
  for (let i = 0; i < sql.length;) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end
      out += ' '
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) throw new ReadOnlyViolation('unterminated comment')
      i = end + 2
      out += ' '
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      for (;;) {
        const k = sql.indexOf(close, j)
        if (k < 0) throw new ReadOnlyViolation('unterminated quote')
        // A doubled quote is an escaped quote inside the literal.
        if (close !== ']' && sql[k + 1] === close) { j = k + 2; continue }
        i = k + 1
        break
      }
      out += c === "'" ? "''" : ' x '
    } else {
      out += c
      i += 1
    }
  }
  return out
}

/** Throws unless sql is one read-only statement (SELECT, WITH ... SELECT or EXPLAIN [QUERY PLAN] SELECT). */
export function assertReadOnlySql(sql: string): void {
  const code = codeOnly(String(sql ?? '')).trim().replace(/;\s*$/, '')
  if (!code) throw new ReadOnlyViolation('empty statement')
  if (code.includes(';')) throw new ReadOnlyViolation('multiple statements')
  if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(code)) throw new ReadOnlyViolation(`not a read: ${code.slice(0, 40)}`)
  const forbidden = FORBIDDEN.exec(code)
  if (forbidden) throw new ReadOnlyViolation(`forbidden keyword ${forbidden[1].toUpperCase()}`)
  if (!/\bSELECT\b/i.test(code)) throw new ReadOnlyViolation('no SELECT')
}

function assertNoWrite(meta: D1Result['meta'] | undefined, db: string): void {
  if (Number(meta?.rows_written ?? 0) > 0 || Number(meta?.changes ?? 0) > 0 || meta?.changed_db === true) {
    throw new ReadOnlyViolation(`write reported by ${db}`)
  }
}

const INNER = Symbol('readOnlyInner')

type WrappedStatement = D1PreparedStatement & { [INNER]: { statement: D1PreparedStatement; sql: string; params: unknown[] } }

function wrapStatement(statement: D1PreparedStatement, sql: string, params: unknown[], dbName: string, ledger: ReadLedger): WrappedStatement {
  const all = async <T>(): Promise<D1Result<T>> => {
    const result = await statement.all<T>()
    assertNoWrite(result.meta, dbName)
    ledger.record({ db: dbName, sql, params, rowsRead: Number(result.meta?.rows_read ?? 0) })
    return result
  }
  const wrapped = {
    [INNER]: { statement, sql, params },
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values), sql, values, dbName, ledger),
    all,
    // first() and raw() return no meta; read through all() so rows_read is always accounted.
    first: async <T>(column?: string): Promise<T | null> => {
      const row = (await all<Record<string, unknown>>()).results?.[0]
      if (row == null) return null
      return (column ? row[column] ?? null : row) as T
    },
    run: async <T>() => all<T>(),
    raw: async () => { throw new ReadOnlyViolation('raw() is not supported') },
  }
  return wrapped as unknown as WrappedStatement
}

export function readOnlyD1(db: D1Database, dbName: string, ledger: ReadLedger): D1Database {
  const wrapped = {
    prepare(sql: string) {
      assertReadOnlySql(sql)
      return wrapStatement(db.prepare(sql), sql, [], dbName, ledger)
    },
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const inner = statements.map((statement) => {
        const unwrapped = (statement as WrappedStatement)[INNER]
        if (!unwrapped) throw new ReadOnlyViolation('batch accepts only statements prepared by this wrapper')
        return unwrapped
      })
      const results = await db.batch<T>(inner.map((item) => item.statement))
      results.forEach((result, index) => {
        assertNoWrite(result.meta, dbName)
        ledger.record({ db: dbName, sql: inner[index].sql, params: inner[index].params, rowsRead: Number(result.meta?.rows_read ?? 0) })
      })
      return results
    },
    exec: async () => { throw new ReadOnlyViolation('exec() is not allowed') },
    dump: async () => { throw new ReadOnlyViolation('dump() is not allowed') },
    withSession: () => { throw new ReadOnlyViolation('withSession() is not allowed') },
  }
  return wrapped as unknown as D1Database
}
