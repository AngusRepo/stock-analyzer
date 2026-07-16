import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRouteAccessPolicy } from './routePolicy'

const unregistered: string[] = []
const publicMutations: string[] = []
const allowedPublicMutations = new Set(['POST /api/auth/exchange'])

const srcDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const indexSource = readFileSync(resolve(srcDir, 'index.ts'), 'utf8')
const mounts = new Map<string, string>()
for (const match of indexSource.matchAll(/app\.route\('([^']+)',\s*(\w+)\)/g)) {
  mounts.set(match[2], match[1])
}
mounts.set('app', '')

const files = [resolve(srcDir, 'index.ts'), ...readdirSync(resolve(srcDir, 'routes'))
  .filter((name) => name.endsWith('.ts'))
  .map((name) => resolve(srcDir, 'routes', name))]

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/(\w+)\.(get|post|put|delete|patch)\('([^']+)'/g)) {
    const [, routerName, rawMethod, routePath] = match
    const mount = mounts.get(routerName)
    if (mount === undefined) continue
    const path = `${mount === '/' ? '' : mount}${routePath}`.replace(/\/+/g, '/')
    const method = rawMethod.toUpperCase()
    if (!path.startsWith('/api/')) continue
    const policy = resolveRouteAccessPolicy(path, method)
    if (policy === 'deny') unregistered.push(`${method} ${path}`)
    if (policy === 'public' && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const key = `${method} ${path}`
      if (!allowedPublicMutations.has(key)) publicMutations.push(key)
    }
  }
}

assert.deepEqual(unregistered, [], `Routes missing a global access policy:\n${unregistered.join('\n')}`)
assert.deepEqual(publicMutations, [], `Unexpected public mutations:\n${publicMutations.join('\n')}`)
