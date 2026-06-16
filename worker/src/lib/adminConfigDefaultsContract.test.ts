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

console.log('adminConfigDefaultsContract.test.ts passed')
