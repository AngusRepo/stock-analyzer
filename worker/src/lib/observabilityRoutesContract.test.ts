const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const readRoutes = fs.readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
const writeRoutes = fs.readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')
const eventsLib = fs.readFileSync('src/lib/observabilityEvents.ts', 'utf8')

assert(readRoutes.includes("'/api/admin/observability/events'"), 'OBS must expose live event report route')
assert(readRoutes.includes("'/api/admin/observability/audit'"), 'OBS must expose persisted audit route')
assert(readRoutes.includes("'/api/admin/observability/drilldown'"), 'OBS must expose incident drilldown route')
assert(readRoutes.includes("'/api/admin/ops/runbook'"), 'OPS must expose read-only runbook route')
assert(readRoutes.includes("'/api/admin/ops/resource-audit'"), 'OPS must expose read-only resource audit route')
assert(writeRoutes.includes("'/api/admin/observability/snapshot'"), 'OBS must expose snapshot writer route')
assert(readRoutes.includes('requireAdminOrServiceToken'), 'OBS read routes must require admin or service token')
assert(writeRoutes.includes('requireAdminOrServiceToken'), 'OBS snapshot route must require admin or service token')
assert(eventsLib.includes('normalizeObservabilityAuditFilters'), 'OBS audit filters must be normalized through a whitelist')
assert(readRoutes.includes('buildObservabilityDrilldown'), 'OBS drilldown route must use central drilldown builder')
assert(readRoutes.includes('buildOpsRunbook'), 'OPS runbook route must use central runbook builder')
assert(readRoutes.includes('buildOpsResourceAudit'), 'OPS resource audit route must use central read-only audit builder')
assert(!readRoutes.includes('severity: c.req.query(\'severity\') as any'), 'OBS audit severity must not be passed through as any')
assert(!readRoutes.includes('domain: c.req.query(\'domain\') as any'), 'OBS audit domain must not be passed through as any')
