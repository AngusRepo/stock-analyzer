// Local cross-language oracle: actual Worker owner against the Python test's SQLite.
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'
import { writeAllocatorForecastArchive, readAllocatorForecastArchive,
  reconcileAllocatorForecastReferences, ALLOCATOR_FORECAST_ACTIVATION_KEY } from '../../../worker/src/lib/allocatorEvFeatureArchive'
import { allocatorForecastActivationFixture } from './allocator_forecast_activation'

const db = new DatabaseSync(process.argv[2])
function prepare(sql: string) {
  let params: any[] = []
  return { bind(...values: any[]) { params = values; return this },
    async first() { return db.prepare(sql).get(...params) ?? null },
    async all() { return { results: db.prepare(sql).all(...params) } },
    async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } } } }
}
const adapter = { prepare, async batch(statements: Array<{ run(): Promise<any> }>) {
  db.exec('BEGIN')
  try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
} }
const objects = new Map<string, string>()
const env = { DB: adapter, CF_VERSION_METADATA: { id: 'fixture-worker' }, ML_CONTROLLER_URL: 'https://controller.fixture.invalid',
  KV: { async get(key: string) { return key === ALLOCATOR_FORECAST_ACTIVATION_KEY ? JSON.stringify(allocatorForecastActivationFixture()) : null } }, ARTIFACTS: {
  async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body, size: Buffer.byteLength(body) } },
  async put(key: string, body: string) { objects.set(key, body) },
} } as any
async function main() {
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const { operation, payload } = JSON.parse(line)
    const result = operation === 'write' ? await writeAllocatorForecastArchive(env, payload)
      : operation === 'reconcile' ? await reconcileAllocatorForecastReferences(env, payload)
        : { body_base64: Buffer.from((await readAllocatorForecastArchive(env, payload.artifact_id)).body).toString('base64') }
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
  } catch (error) { process.stdout.write(JSON.stringify({ error: String(error) }) + '\n') }
}
db.close()
}
main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1 })
