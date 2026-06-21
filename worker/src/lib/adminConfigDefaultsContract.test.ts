import fs from 'node:fs'
import assert from 'node:assert/strict'

const source = fs.readFileSync('src/routes/adminConfigCoreRoutes.ts', 'utf8')

const routeStart = source.indexOf("adminConfigCoreRoutes.post('/api/admin/config/push-defaults'")
assert(routeStart >= 0, 'push-defaults route must exist')
const routeEnd = source.indexOf("adminConfigCoreRoutes.get('/api/admin/kv-get'", routeStart)
const routeBody = source.slice(routeStart, routeEnd >= 0 ? routeEnd : undefined)

assert(
  !routeBody.includes('getTradingConfig(c.env.KV).catch(() => null)'),
  'push-defaults must not silently replace an unreadable trading config with defaults',
)

assert(
  routeBody.includes('refusing to push defaults over an unverified source') &&
    routeBody.includes('}, 409)'),
  'push-defaults must fail closed when current trading config cannot be verified',
)

assert(
  source.includes("adminConfigCoreRoutes.get('/api/admin/config/repair-plan'"),
  'admin config repair-plan route must exist',
)

const repairStart = source.indexOf("adminConfigCoreRoutes.post('/api/admin/config/repair-critical-defaults'")
assert(repairStart >= 0, 'admin config repair-critical-defaults route must exist')
const repairEnd = source.indexOf("adminConfigCoreRoutes.get('/api/admin/risk-config'", repairStart)
const repairBody = source.slice(repairStart, repairEnd >= 0 ? repairEnd : undefined)

assert(
  repairBody.includes('const dryRun = body?.dry_run !== false') &&
    repairBody.includes("mode: 'dry_run'") &&
    repairBody.includes('production_effect: false'),
  'trading config repair route must dry-run by default',
)

assert(
  repairBody.includes("X-Confirm-Trading-Config') !== 'true'") &&
    repairBody.includes('required to write trading:config operational defaults'),
  'trading config repair write must require explicit confirmation header',
)

console.log('adminConfigDefaultsContract.test.ts passed')
