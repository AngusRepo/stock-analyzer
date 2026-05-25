import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const adminReadRoutes = fs.readFileSync('src/routes/adminReadRoutes.ts', 'utf8')

assert(
  adminReadRoutes.includes("adminReadRoutes.get('/api/admin/compute-profiles'"),
  'admin read routes must expose compute profile readback for Cloud Run/Modal wait attribution',
)

assert(
  adminReadRoutes.includes('await_sec') &&
    adminReadRoutes.includes('compute_owner') &&
    adminReadRoutes.includes('remote_function') &&
    adminReadRoutes.includes('profile_json'),
  'compute profile readback must expose wait attribution columns and raw profile JSON',
)

assert(
  adminReadRoutes.includes('computeProfileMissingWaitColumns') &&
    adminReadRoutes.includes('legacy_columns: legacyColumns') &&
    adminReadRoutes.includes('normalizeComputeProfileReadRow'),
  'compute profile readback must support legacy tables before wait-column migration is applied',
)

assert(
  adminReadRoutes.includes("c.req.query('job')") &&
    adminReadRoutes.includes("c.req.query('provider')") &&
    adminReadRoutes.includes('Math.max(1, Math.min'),
  'compute profile readback must support bounded job/provider filtering',
)
