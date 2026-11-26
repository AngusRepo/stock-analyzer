import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const client = fs.readFileSync(path.join(root, 'src', 'lib', 'apiClient.ts'), 'utf8')
const adminAccess = fs.readFileSync(path.join(root, 'src', 'lib', 'adminAccess.ts'), 'utf8')

// apiClient reads import.meta.env at load, so these stay source contracts like the other src/lib checks.
assert(client.includes('const sentToken = token'), 'apiRequest must remember which session token it sent')
assert(client.includes('if (sentToken && sentToken === token && headers.Authorization === `Bearer ${sentToken}`) clearToken()'), 'A 401 may only clear the token this request carried and that is still current')
assert(!/status === 401\) \{\s*clearToken\(\)/.test(client), 'A bare 401 must not clear the session unconditionally')

assert(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(adminAccess), 'The public bundle must not hard-code an admin email; trust /auth/me is_primary_admin')
assert(adminAccess.includes('user.is_primary_admin === true'), 'Primary admin must come from the server flag')

console.log('apiClientAuthContract: OK')
