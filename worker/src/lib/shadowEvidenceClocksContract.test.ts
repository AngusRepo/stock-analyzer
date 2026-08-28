import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd())
const clocks = fs.readFileSync(path.join(root, 'src/lib/shadowEvidenceClocks.ts'), 'utf8')
const routes = fs.readFileSync(path.join(root, 'src/routes/adminReadRoutes.ts'), 'utf8')
const state = fs.readFileSync(path.join(root, 'src/lib/stateSpaceV2Evidence.ts'), 'utf8')

for (const mechanism of ['shadow_a', 'rfs_allocator', 'execution_parity']) {
  assert.match(clocks, new RegExp(`mechanism: '${mechanism}'`))
}
assert.match(clocks, /Promise\.all\(\[/)
assert.match(clocks, /databaseForDataDomain\(env, 'learning'\)/)
assert.match(clocks, /databaseForDataDomain\(env, 'core'\)/)
assert.match(clocks, /databaseForDataDomain\(env, 'paper'\)/)
assert.match(clocks, /databaseForDataDomain\(env, 'execution'\)/)
assert.match(clocks, /auto_promote: false/)
assert.match(clocks, /production_effect: false/)
assert.match(routes, /\/api\/admin\/observability\/evidence-clocks/)
assert.match(state, /risk_overlay_comparison_only/)
assert.doesNotMatch(clocks, /stateSpaceClock|state_space_overlay/)

console.log('shadowEvidenceClocksContract.test.ts passed')
