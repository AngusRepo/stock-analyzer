import assert from 'node:assert/strict'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const wranglerConfig = fs.readFileSync('wrangler.toml', 'utf8')

assert.equal(pkg.dependencies?.hono, '4.12.25', 'Hono should be pinned to reviewed stable version')
assert.equal(pkg.devDependencies?.wrangler, '4.110.0', 'Wrangler should be pinned to reviewed stable version')
assert.equal(pkg.devDependencies?.typescript, '6.0.3', 'TypeScript should be pinned to reviewed stable version')
assert(!String(pkg.devDependencies?.typescript ?? '').startsWith('^'), 'TypeScript pin must not float')
assert.match(wranglerConfig, /compatibility_date\s*=\s*"2026-07-01"/)

