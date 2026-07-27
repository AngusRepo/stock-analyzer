import assert from 'node:assert/strict'
import fs from 'node:fs'

const runtime = fs.readFileSync('src/lib/s12RuntimeBars.ts', 'utf8')
const bindings = fs.readFileSync('src/node-runner/cloudflareRestBindings.ts', 'utf8')
const runner = fs.readFileSync('src/node-runner/s12StructureBatchJobMain.ts', 'utf8')
const routes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const lifecycle = fs.readFileSync('src/lib/allocatorEvDailyLifecycle.ts', 'utf8')
const config = fs.readFileSync('wrangler.toml', 'utf8')

assert(runtime.includes('EVIDENCE_ARTIFACT_READER'))
assert(bindings.includes('class RestEvidenceArtifactReader'))
assert(bindings.includes('invalid') === false || bindings.includes('rejected non-S12 key'))
assert(runner.includes('EVIDENCE_ARTIFACT_READER: RestEvidenceArtifactReader.fromEnv()'))
assert(routes.includes('/api/internal/evidence-artifacts/s12-research/read'))
assert(routes.includes("domain='s12_research_minute_bars'"))
assert(routes.includes("retention_class='raw_market_unreferenced'"))
assert(routes.includes("callbackSource === 'evening_chain'"))
assert(routes.includes('shadow complete without pipeline continuation'))
assert(lifecycle.includes('recoverCompletedS12DurableCallback'))
assert(config.includes('S12_DURABLE_STRUCTURE_JOB_ENABLED = "0"'))
