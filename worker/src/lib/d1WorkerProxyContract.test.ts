const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')

assert(
  adminControlRoutes.includes("adminControlRoutes.post('/api/internal/d1/query'") &&
    adminControlRoutes.includes('const authError = requireServiceToken(c)'),
  'internal D1 query proxy must require the service token',
)

assert(
  adminControlRoutes.includes("const D1_QUERY_ALLOWED_READ = new Set(['SELECT', 'WITH'])") &&
    adminControlRoutes.includes('D1_QUERY_FORBIDDEN_MUTATION') &&
    adminControlRoutes.includes("throw new Error('only SELECT/WITH are allowed')") &&
    adminControlRoutes.includes("throw new Error('WITH query must be read-only')"),
  'internal D1 query proxy must stay read-only',
)

assert(
  adminControlRoutes.includes('normalizeD1QueryStatement') &&
    adminControlRoutes.includes("throw new Error('multiple SQL statements are not allowed')") &&
    adminControlRoutes.includes("throw new Error('SQL comments are not allowed')"),
  'internal D1 query proxy must reject multi-statement/comment payloads',
)

assert(
  adminControlRoutes.includes('c.env.DB.prepare(statement.sql).bind(...statement.params).all()') &&
    adminControlRoutes.includes("mode: 'worker_d1_query'") &&
    adminControlRoutes.includes('max_rows'),
  'internal D1 query proxy must execute via Worker D1 binding and expose bounded read results',
)
