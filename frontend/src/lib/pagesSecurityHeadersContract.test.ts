import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const headers = fs.readFileSync(path.join(root, 'public', '_headers'), 'utf8')
const csp = headers.match(/Content-Security-Policy(?:-Report-Only)?: (.+)/)?.[1] ?? ''

assert(csp, 'Pages must send a Content-Security-Policy (Report-Only until the reports are clean)')
assert(csp.includes("script-src 'self'") && !csp.includes("'unsafe-eval'") && !/script-src[^;]*'unsafe-inline'/.test(csp), 'CSP must keep scripts to this origin with no inline or eval')
assert(csp.includes("connect-src 'self' https://stockvision-worker.angus-solo-dev.workers.dev"), 'CSP connect-src must allow only this origin and the production Worker')
assert(csp.includes("object-src 'none'") && csp.includes("base-uri 'self'"), 'CSP must block plugins and base-tag hijacking')
assert(headers.includes('X-Frame-Options: DENY'), 'Pages must refuse framing (frame-ancestors is ignored in Report-Only mode)')
assert(headers.includes('Cross-Origin-Opener-Policy: same-origin'), 'Pages must isolate the browsing context')
assert(headers.includes('/assets/*\n  Cache-Control: public, max-age=31536000, immutable'), 'Hashed assets must keep their immutable cache rule')

console.log('pagesSecurityHeadersContract: OK')
