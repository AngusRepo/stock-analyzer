import assert from 'node:assert/strict'
import fs from 'node:fs'

const lifecycle = fs.readFileSync('src/lib/allocatorEvDailyLifecycle.ts', 'utf8')
const chain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')

const writer = lifecycle.slice(
  lifecycle.indexOf('export async function recordAllocatorEvLifecycle'),
  lifecycle.indexOf('export async function inspectAllocatorSnapshotClosure'),
)

assert.match(writer, /authorityDb: D1Database = db/)
assert.match(writer, /if \(splitAuthorityDb && !\(await hasAuthority\(\)\)\) return false/)
assert.match(writer, /return splitAuthorityDb \? await hasAuthority\(\) : true/)
assert.match(writer, /FROM pipeline_stage_runs authority/)

const authorityCalls = chain.match(/recordAllocatorEvLifecycle\([\s\S]*?stageAuthority:[\s\S]*?\},\s*databaseForDataDomain\(env, 'ops'\)\)/g) ?? []
assert.equal(authorityCalls.length, 3, 'every split-D1 lifecycle authority write must read its fence from ops')
assert.match(chain, /allocator-lifecycle:\$\{input\.state\}:after_write/)
