const D1_BATCH_ALLOWED_DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])

export function normalizeSingleD1BatchStatement(
  rawSql: unknown,
  index: number,
  allowedVerbs: ReadonlySet<string> = D1_BATCH_ALLOWED_DML,
): string {
  const sql = typeof rawSql === 'string' ? rawSql.trim() : ''
  if (!sql) throw new Error(`statement ${index}: sql is required`)

  let quote: "'" | '"' | '`' | ']' | null = null
  let lineComment = false
  let blockComment = false
  let terminator = -1

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    const next = sql[i + 1]

    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (quote) {
      const close = quote === ']' ? ']' : quote
      if (char === close) {
        if (next === close && quote !== ']') i += 1
        else quote = null
      }
      continue
    }
    if (char === '-' && next === '-') {
      lineComment = true
      i += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      i += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      if (terminator >= 0) throw new Error(`statement ${index}: multiple SQL statements are not allowed`)
      quote = char
      continue
    }
    if (char === '[') {
      if (terminator >= 0) throw new Error(`statement ${index}: multiple SQL statements are not allowed`)
      quote = ']'
      continue
    }
    if (char === ';') {
      if (terminator >= 0) throw new Error(`statement ${index}: multiple SQL statements are not allowed`)
      terminator = i
      continue
    }
    if (terminator >= 0 && !/\s/.test(char)) {
      throw new Error(`statement ${index}: multiple SQL statements are not allowed`)
    }
  }

  const normalized = (terminator >= 0 ? sql.slice(0, terminator) : sql).trim()
  const verb = normalized.split(/\s+/, 1)[0]?.toUpperCase()
  if (!allowedVerbs.has(verb)) {
    throw new Error(`statement ${index}: SQL verb ${verb || 'missing'} is not allowed`)
  }
  return normalized
}
