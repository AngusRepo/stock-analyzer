import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd(), 'src')
const api = fs.readFileSync(path.join(root, 'lib/api.ts'), 'utf8')
const page = fs.readFileSync(path.join(root, 'pages/ObservabilityPage.tsx'), 'utf8')

assert.match(api, /evidenceClocks: \(\) => get<ShadowEvidenceClockReport>/)
assert.match(page, /function EvidenceClockPanel/)
assert.match(page, /sm:grid-cols-2 xl:grid-cols-3/)
assert.match(page, /comparison lanes do not share maturity credit/)
assert.match(page, /auto promote OFF/)
assert.match(page, /已證偽或退役的機制不再占用成熟時鐘/)
assert.match(api, /mechanism: 'shadow_a' \| 'rfs_allocator' \| 'execution_parity'/)
assert.doesNotMatch(page, /initialLoading = \[[^\]]*evidenceClocks/)

console.log('observabilityEvidenceClocks.test.ts passed')
