import assert from 'node:assert/strict'
import fs from 'node:fs'

const panel = fs.readFileSync('src/components/observability/LearningCutoverPanel.tsx', 'utf8')
const api = fs.readFileSync('src/lib/api.ts', 'utf8')
const route = fs.readFileSync('../worker/src/routes/adminReadRoutes.ts', 'utf8')

assert.match(route, /active_domains: activeDomains/)
assert.match(route, /MULTI_D1_STRICT/)
assert.match(api, /active_domains: string\[\]/)
assert.match(panel, /正式 owner：\{learningActive \? 'Learning D1' : 'legacy D1'\}/)
assert.match(panel, /legacy D1 不再承擔這些寫入/)
assert.match(panel, /Learning routing contract/)
assert.match(panel, /domain\?\.routing_contract_ready \? '已 closure'/)
assert.doesNotMatch(panel, /routingGates\.filter/)
console.log('learning cutover panel contract tests passed')
