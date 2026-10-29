import { strict as assert } from 'node:assert'
import {
  KV_CONFIG_MANIFEST_SCHEMA,
  KV_CONFIG_DIGEST_KEY,
  canonicalJson,
  checkKvConfigDrift,
  kvConfigDigest,
  parseKvConfigManifest,
  runKvConfigDriftCheck,
  withoutPaths,
} from './kvConfigDigest'

const SECRET = 'a'.repeat(64)
const digest = (raw: string, runtime: string[]) => kvConfigDigest(raw, runtime, SECRET)

async function main() {
  // A different key gives a different digest; a malformed key is rejected.
  assert.notEqual(await kvConfigDigest('{"a":1}', [], SECRET), await kvConfigDigest('{"a":1}', [], 'b'.repeat(64)))
  await assert.rejects(kvConfigDigest('{"a":1}', [], 'short'), /digest_key_invalid/)

  // Key order and whitespace do not change the digest; values do.
  assert.equal(canonicalJson({ b: [1, { d: 2, c: 'x' }], a: null }), '{"a":null,"b":[1,{"c":"x","d":2}]}')
  assert.equal(await digest('{"a":1, "b":2}', []), await digest('{\n "b": 2,\n "a": 1.0\n}', []))
  assert.notEqual(await digest('{"a":1}', []), await digest('{"a":2}', []))

  // Runtime-owned paths are removed before hashing; a missing path is not an error.
  const runtime = ['alphaFramework.allocation.controller', 'alphaFramework.allocation.opbArmPrior', 'absent.path']
  const base = { alphaFramework: { allocation: { controller: 'A', opbArmPrior: { v: 1 }, budget: 3 } }, risk: { stop: 0.05 } }
  const published = structuredClone(base)
  published.alphaFramework.allocation.controller = 'OnlinePortfolioBandit'
  published.alphaFramework.allocation.opbArmPrior = { v: 2 }
  assert.equal(await digest(JSON.stringify(base), runtime), await digest(JSON.stringify(published), runtime))
  const tuned = structuredClone(base)
  tuned.alphaFramework.allocation.budget = 4
  assert.notEqual(await digest(JSON.stringify(base), runtime), await digest(JSON.stringify(tuned), runtime))
  assert.deepEqual(withoutPaths(base, runtime), { alphaFramework: { allocation: { budget: 3 } }, risk: { stop: 0.05 } })
  assert.equal(base.alphaFramework.allocation.controller, 'A', 'input is not mutated')

  const pinned = await digest(JSON.stringify(base), runtime)
  const manifest = parseKvConfigManifest({
    schema_version: KV_CONFIG_MANIFEST_SCHEMA,
    store: 'gs://bucket/kv-config/',
    keys: {
      'trading:config': { digest: pinned, runtime_owned: runtime },
      'trading:risk_config': { digest: '0'.repeat(64), runtime_owned: [] },
      'ml:config': { digest: '1'.repeat(64), runtime_owned: [] },
    },
  })
  const store = new Map<string, string>([
    [KV_CONFIG_DIGEST_KEY, SECRET], ['trading:config', JSON.stringify(published)], ['ml:config', 'not json'],
  ])
  const kv = { get: async (key: string) => store.get(key) ?? null } as any
  const results = await checkKvConfigDrift(kv, manifest)
  assert.deepEqual(results.map((r) => [r.key, r.status]), [
    ['trading:config', 'match'], ['trading:risk_config', 'missing'], ['ml:config', 'invalid'],
  ])

  assert.throws(() => parseKvConfigManifest({ schema_version: 'other', keys: {} }), /schema_mismatch/)
  assert.throws(() => parseKvConfigManifest({ schema_version: KV_CONFIG_MANIFEST_SCHEMA, keys: {} }), /manifest_empty/)
  assert.throws(() => parseKvConfigManifest({
    schema_version: KV_CONFIG_MANIFEST_SCHEMA, keys: { k: { digest: 'abc', runtime_owned: [] } },
  }), /entry_invalid:k/)

  // The task fails (raising the scheduler alert) on drift or an unreachable manifest, and passes on match.
  const onlyTrading = { ...manifest, keys: { 'trading:config': manifest.keys['trading:config'] } }
  const serve = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as any
  assert.match(await runKvConfigDriftCheck(kv, serve(onlyTrading)), /^kv_config_drift trading:config=match:/)
  store.set('trading:config', JSON.stringify(tuned))
  await assert.rejects(runKvConfigDriftCheck(kv, serve(onlyTrading)), /kv_config_drift trading:config=drift:/)
  await assert.rejects(runKvConfigDriftCheck(kv, serve({}, 503)), /manifest_unavailable:503/)
  store.delete(KV_CONFIG_DIGEST_KEY)
  await assert.rejects(runKvConfigDriftCheck(kv, serve(onlyTrading)), /digest_key_missing/)

  console.log('kvConfigDigest tests passed')
}

void main().catch((error) => { throw error })
