/** Read-only Node host for the unchanged full-population Atomic replay kernel. */
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { replayCanonicalAtomicPopulation } from '../lib/atomicStrategySource'
import { RestAtomicArtifactReader, RestD1Database } from './cloudflareRestBindings'
import type { Bindings } from '../types'

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
console.log = console.warn = () => undefined
async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (!input || !['decisionDeadline,producerRunId,signalDate', 'continuations,decisionDeadline,producerRunId,signalDate']
    .includes(Object.keys(input).sort().join(','))) throw new Error('atomic_source_request_identity_invalid')
  const ops = RestD1Database.fromEnv('CF_D1_OPS_DB_ID')
  const readOnly = { prepare(sql: string) {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('atomic_population_read_only')
    return ops.prepare(sql)
  } } as D1Database
  const reader = RestAtomicArtifactReader.fromEnv()
  const env = { DB: readOnly, OPS_DB: readOnly, MULTI_D1_ACTIVE_DOMAINS: 'ops', MULTI_D1_STRICT: 'true',
    ARTIFACTS: { async get(key: string) { const body = await reader.read(key)
      return body == null ? null : { text: async () => body } } } } as unknown as Bindings
  const result = await replayCanonicalAtomicPopulation(env, input)
  process.stdout.write(JSON.stringify(result))
}
main().catch(error => { process.stderr.write(String(error?.message ?? error)); process.exitCode = 1 })
