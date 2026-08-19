import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const routeSource = readFileSync(new URL('../routes/adminReadRoutes.ts', import.meta.url), 'utf8')

assert.match(routeSource, /const requestedDomain = c\.req\.query\('domain'\)/)
assert.match(routeSource, /const closureReport = requestedDomain[\s\S]*inspectDataDomainCutoverReadiness\(c\.env\.DB, null, readinessContext\)[\s\S]*: report/)
assert.match(routeSource, /domains: closureReport\.domains/)
assert.doesNotMatch(routeSource, /domains: report\.domains/)

console.log('data domain ten-year closure route contract tests passed')