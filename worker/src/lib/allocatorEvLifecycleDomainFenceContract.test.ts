import assert from 'node:assert/strict'
import fs from 'node:fs'

const lifecycle = fs.readFileSync('src/lib/allocatorEvDailyLifecycle.ts', 'utf8')
const chain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const research = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')

const writer = lifecycle.slice(
  lifecycle.indexOf('export async function recordAllocatorEvLifecycle'),
  lifecycle.indexOf('export async function inspectAllocatorSnapshotClosure'),
)

assert.match(writer, /authorityDb: D1Database = db/)
assert.match(writer, /if \(splitAuthorityDb && !\(await hasAuthority\(\)\)\) return false/)
assert.match(writer, /return splitAuthorityDb \? await hasAuthority\(\) : true/)
assert.match(writer, /const authorityBindings = authority && !splitAuthorityDb/)
assert.match(writer, /FROM pipeline_stage_runs authority/)

const authorityCalls = chain.match(/recordAllocatorEvLifecycle\([\s\S]*?stageAuthority:[\s\S]*?\},\s*databaseForDataDomain\(env, 'ops'\)\)/g) ?? []
assert.equal(authorityCalls.length, 3, 'every split-D1 lifecycle authority write must read its fence from ops')
assert.match(research, /stageAuthority: params\.runId[\s\S]*?databaseForDataDomain\(env, 'ops'\)\)/)
assert.equal(orchestrator.match(/recoveryAttempt: Math\.max\(0, Number\(msg\.attempt \?\? 0\)\)/g)?.length, 2)
assert.doesNotMatch(orchestrator, /Number\(claimed\.attempt_count \?\? 1\) - 1/)
assert.match(chain, /allocator-lifecycle:\$\{input\.state\}:after_write/)

const inspector = lifecycle.slice(
  lifecycle.indexOf('export async function inspectAllocatorSnapshotClosure'),
  lifecycle.indexOf('function staleVerifyTrigger'),
)
assert.match(inspector, /learningDb\?: D1Database/)
assert.match(inspector, /opsDb\?: D1Database/)
assert.match(inspector, /coreDb\?: D1Database/)
assert.doesNotMatch(inspector, /JOIN canonical_reference/)
assert.match(lifecycle, /const learningDb = databaseForDataDomain\(env, 'learning'\)/)
for (const source of [chain, research]) {
  assert.match(source, /learningDb: databaseForDataDomain\(env, 'learning'\)/)
}
