import assert from 'node:assert/strict'
import fs from 'node:fs'

const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const learningSchema = fs.readFileSync('domain-schemas/learning.sql', 'utf8')
const learningBaseline = fs.readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
const registry = fs.readFileSync('src/lib/dataDomainRegistry.ts', 'utf8')

assert(
  adminControlRoutes.includes("adminControlRoutes.post('/api/internal/state-space-shadow/callback'"),
  'state-space shadow callback route must exist',
)

assert(
  adminControlRoutes.includes('state_space_shadow_results') &&
    adminControlRoutes.includes('ON CONFLICT(run_date, run_id, model_name, symbol) DO UPDATE'),
  'state-space shadow callback must upsert structured D1 rows',
)

const callbackBlock = adminControlRoutes.slice(
  adminControlRoutes.indexOf("adminControlRoutes.post('/api/internal/state-space-shadow/callback'"),
  adminControlRoutes.indexOf("adminControlRoutes.get('/api/admin/adaptive-params'"),
)
assert(callbackBlock.includes("const learningDb = databaseForDataDomain(c.env, 'learning')"))
assert(callbackBlock.includes('statements.push(learningDb.prepare(sql).bind('))
assert(callbackBlock.includes('await learningDb.batch(statements)'))
assert(!callbackBlock.includes('c.env.DB.prepare(sql)'))
assert(!callbackBlock.includes('c.env.DB.batch(statements)'))

assert(
  learningSchema.includes('CREATE TABLE IF NOT EXISTS state_space_shadow_results') &&
    learningBaseline.includes('CREATE TABLE IF NOT EXISTS state_space_shadow_results'),
  'state-space shadow result table must be in the canonical Learning schema and baseline',
)

assert(
  learningSchema.includes('idx_state_space_shadow_errors') &&
    learningBaseline.includes('idx_state_space_shadow_errors'),
  'state-space shadow table needs Learning query indexes for validation and fallback analysis',
)
const learningRegistryBlock = registry.slice(registry.indexOf('  learning: new Set(['), registry.indexOf('  ops: new Set(['))
assert(learningRegistryBlock.includes("'state_space_shadow_results'"))
