import assert from 'node:assert/strict'
import fs from 'node:fs'

const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const schema = fs.readFileSync('schema.sql', 'utf8')
const migration = fs.readFileSync('migration_state_space_shadow_results.sql', 'utf8')

assert(
  adminControlRoutes.includes("adminControlRoutes.post('/api/internal/state-space-shadow/callback'"),
  'state-space shadow callback route must exist',
)

assert(
  adminControlRoutes.includes('state_space_shadow_results') &&
    adminControlRoutes.includes('ON CONFLICT(run_date, run_id, model_name, symbol) DO UPDATE'),
  'state-space shadow callback must upsert structured D1 rows',
)

assert(
  schema.includes('CREATE TABLE IF NOT EXISTS state_space_shadow_results') &&
    migration.includes('CREATE TABLE IF NOT EXISTS state_space_shadow_results'),
  'state-space shadow result table must be in canonical schema and migration',
)

assert(
  schema.includes('idx_state_space_shadow_errors') &&
    migration.includes('idx_state_space_shadow_errors'),
  'state-space shadow table needs query indexes for validation and fallback analysis',
)
