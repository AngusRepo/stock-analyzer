import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { captureWorkerDeployGuard, assertWorkerDeployGuardUnchanged, PRODUCTION_WORKER_HEALTH_URL } from '../../../tools/worker_deploy_preflight.mjs'

const candidate = 'a'.repeat(40)
const liveSource = 'b'.repeat(40)
const nextMain = 'c'.repeat(40)
const nextLive = 'd'.repeat(40)
const versionId = '11111111-2222-4333-8444-555555555555'

test('Worker deployment input gate includes the executable preflight helper', () => {
  const wrapper = readFileSync(new URL('../../../tools/deploy_worker_with_provenance.mjs', import.meta.url), 'utf8')
  const statusCall = wrapper.match(/const dirty = run\('git', \[([^\]]+)\], \{ capture: true \}\)/)?.[1]
  assert.ok(statusCall, 'deployment input git status gate exists')
  assert.match(statusCall, /'tools\/worker_deploy_preflight\.mjs'/)
})

function fixture(productionBranch = 'main') {
  const state = {
    remoteSha: candidate,
    remoteOutput: null as string | null,
    missing: new Set<string>(),
    unrelated: new Set<string>(),
    gitCalls: [] as string[][],
    healthCalls: [] as { url: string, options: RequestInit }[],
    status: 200,
    health: { status: 'ok', provenance: { schema: 'v1', provider: 'cloudflare-workers', attested: true, sourceSha: liveSource, versionId } } as any,
  }
  const options = {
    sourceSha: candidate, canonicalProductionBranch: 'main', productionBranch,
    run(command: string, args: string[], runOptions: { capture: boolean }) {
      assert.equal(command, 'git')
      assert.equal(runOptions.capture, true)
      state.gitCalls.push(args)
      if (args[0] === 'ls-remote') {
        assert.deepEqual(args, ['ls-remote', 'origin', 'refs/heads/main'])
        return state.remoteOutput ?? `${state.remoteSha}\trefs/heads/main\n`
      }
      if (args[0] === 'cat-file') {
        assert.equal(args[1], '-e')
        const sha = args[2].replace(/\^\{commit\}$/, '')
        assert.equal(args[2], `${sha}^{commit}`)
        if (state.missing.has(sha)) throw new Error('missing commit')
        return ''
      }
      if (args[0] === 'merge-base') {
        assert.equal(args[1], '--is-ancestor')
        assert.equal(args[3], candidate)
        if (state.unrelated.has(args[2])) throw new Error('not ancestor')
        return ''
      }
      throw new Error(`unexpected git operation: ${args[0]}`)
    },
    async fetchImpl(url: string, fetchOptions: RequestInit) {
      state.healthCalls.push({ url, options: fetchOptions })
      return new Response(JSON.stringify(state.health), { status: state.status })
    },
  }
  return { state, options }
}

test('Worker deploy guard reads fresh main and attested live ancestry twice without mutating Git', async () => {
  const { state, options } = fixture()
  const first = await captureWorkerDeployGuard(options)
  assert.deepEqual(first, { mainSha: candidate, workerSourceSha: liveSource, workerVersionId: versionId })
  assert.deepEqual(await assertWorkerDeployGuardUnchanged(first, options), first)
  assert.equal(state.gitCalls.filter(args => args[0] === 'ls-remote').length, 2)
  assert.deepEqual(state.gitCalls.filter(args => args[0] === 'merge-base'), [
    ['merge-base', '--is-ancestor', candidate, candidate], ['merge-base', '--is-ancestor', liveSource, candidate],
    ['merge-base', '--is-ancestor', candidate, candidate], ['merge-base', '--is-ancestor', liveSource, candidate],
  ])
  assert.equal(state.gitCalls.some(args => ['fetch', 'merge', 'push'].includes(args[0])), false)
  for (const call of state.healthCalls) {
    assert.equal(call.url, PRODUCTION_WORKER_HEALTH_URL)
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.cache, 'no-store')
    assert.deepEqual(call.options.headers, { 'Cache-Control': 'no-cache', Pragma: 'no-cache' })
    assert.ok(call.options.signal instanceof AbortSignal)
  }
})

test('Worker deploy guard rejects stale local origin/main when fresh remote main differs from canonical HEAD', async () => {
  const { state, options } = fixture()
  state.remoteSha = nextMain
  await assert.rejects(captureWorkerDeployGuard(options), /HEAD=fresh origin\/main/)
  assert.equal(state.healthCalls.length, 0)
})

test('Worker deploy guard requires review and local availability of fresh main, without auto fetch', async () => {
  const { state, options } = fixture('codex/reviewed-release')
  state.remoteSha = nextMain
  state.missing.add(nextMain)
  await assert.rejects(captureWorkerDeployGuard(options), /remote production branch commit .* is missing locally; fetch and review/)
  assert.deepEqual(state.gitCalls.map(args => args[0]), ['ls-remote', 'cat-file'])
})

test('Worker deploy guard requires fresh main ancestry even for the existing non-main release path', async () => {
  const { state, options } = fixture('codex/reviewed-release')
  state.remoteSha = nextMain
  state.unrelated.add(nextMain)
  await assert.rejects(captureWorkerDeployGuard(options), /fresh remote production branch source .* is not an ancestor/)
  assert.equal(state.healthCalls.length, 0)
})

for (const raw of ['', `${candidate}\trefs/heads/other`, `${candidate}\trefs/heads/main\n${nextMain}\trefs/heads/main`, 'invalid\trefs/heads/main']) {
  test(`Worker deploy guard rejects an ambiguous or malformed remote ref: ${JSON.stringify(raw)}`, async () => {
    const { state, options } = fixture()
    state.remoteOutput = raw
    await assert.rejects(captureWorkerDeployGuard(options), /fresh remote refs\/heads\/main could not be verified/)
    assert.equal(state.healthCalls.length, 0)
  })
}

test('Worker deploy guard refuses to overwrite a live source outside candidate ancestry', async () => {
  const { state, options } = fixture()
  state.unrelated.add(liveSource)
  await assert.rejects(captureWorkerDeployGuard(options), /live Worker source .* is not an ancestor/)
})

test('Worker deploy guard requires live source to be locally inspectable', async () => {
  const { state, options } = fixture()
  state.missing.add(liveSource)
  await assert.rejects(captureWorkerDeployGuard(options), /live Worker commit .* is missing locally; fetch and review/)
})

for (const [name, mutate] of [
  ['unattested', (h: any) => { h.provenance.attested = false }],
  ['invalid source', (h: any) => { h.provenance.sourceSha = 'main' }],
  ['missing version', (h: any) => { delete h.provenance.versionId }],
  ['wrong provider', (h: any) => { h.provenance.provider = 'other' }],
  ['unhealthy', (h: any) => { h.status = 'error' }],
] as const) {
  test(`Worker deploy guard fails closed for ${name} production health`, async () => {
    const { state, options } = fixture()
    mutate(state.health)
    await assert.rejects(captureWorkerDeployGuard(options), /source\/version is not attested/)
    assert.equal(state.gitCalls.some(args => args[0] === 'cat-file' && args[2].startsWith(liveSource)), false)
  })
}

test('Worker deploy guard fails closed for unavailable production health', async () => {
  const { state, options } = fixture()
  state.status = 502
  await assert.rejects(captureWorkerDeployGuard(options), /health attestation unavailable/)
})

for (const [key, mutate] of [
  ['mainSha', (s: ReturnType<typeof fixture>['state']) => { s.remoteSha = nextMain }],
  ['workerSourceSha', (s: ReturnType<typeof fixture>['state']) => { s.health.provenance.sourceSha = nextLive }],
  ['workerVersionId', (s: ReturnType<typeof fixture>['state']) => { s.health.provenance.versionId = '99999999-2222-4333-8444-555555555555' }],
] as const) {
  test(`Worker deploy guard catches ${key} drift after schema gates even when ancestry remains valid`, async () => {
    const { state, options } = fixture('codex/reviewed-release')
    const baseline = await captureWorkerDeployGuard(options)
    mutate(state)
    await assert.rejects(assertWorkerDeployGuardUnchanged(baseline, options), new RegExp(`production changed during deployment gates: ${key}`))
    assert.equal(state.gitCalls.filter(args => args[0] === 'ls-remote').length, 2)
  })
}
