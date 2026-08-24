import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync('src/pages/BotDashboard.tsx', 'utf8')

assert(page.includes('isL4ExecutableRecommendation'))
assert.match(page, /hasBuySignal && selected && engine === 'sparse_tangent_inverse_risk'/)
assert(page.includes("view: 'card'") && page.includes('timeoutMs: 15_000'))
assert(page.includes('L4 final {executableRecs.length}'))
assert(page.includes('BUY label only {scoreOnlyRecs.length}'))
assert(page.includes('rows={executableRecs}'))
assert(page.includes('rows={scoreOnlyRecs}'))
assert(page.includes('L4 selected=1'))
assert(page.includes('isError') && page.includes('refetch()'))
assert(!page.includes('evening chain formal BUY / STRONG BUY'))

console.log('BotDashboard L4 candidate semantics contracts passed')
