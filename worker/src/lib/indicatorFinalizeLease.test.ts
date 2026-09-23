import assert from 'node:assert/strict'
import { indicatorFinalizeLeaseActive, withIndicatorFinalizeLease } from './indicatorFinalizeLease'

async function main() {
  let owner = 'first'
  let expires = new Date(Date.now() + 1_200_000).toISOString()
  const env: any = { DB: { prepare() { return { bind(...args: string[]) { return {
    async first() { return { expires_at: expires } },
    async run() { if (args[2] === owner) expires = args[0]; return { success: true } },
  } } } } } }
  assert.equal(await indicatorFinalizeLeaseActive(env, '2026-09-22', 'run'), true)
  await assert.rejects(withIndicatorFinalizeLease(env, '2026-09-22', 'run', owner,
    async () => { throw Error('D1 overloaded') }), /D1 overloaded/)
  assert.equal(await indicatorFinalizeLeaseActive(env, '2026-09-22', 'run'), false)
  expires = new Date(Date.now() + 1_200_000).toISOString()
  owner = 'replacement'
  await withIndicatorFinalizeLease(env, '2026-09-22', 'run', 'first', async () => 1)
  assert.equal(await indicatorFinalizeLeaseActive(env, '2026-09-22', 'run'), true)
  assert.equal(await withIndicatorFinalizeLease(env, '2026-09-22', 'run', owner, async () => 42), 42)
  assert.equal(await indicatorFinalizeLeaseActive(env, '2026-09-22', 'run'), false)
  console.log('indicatorFinalizeLease tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
