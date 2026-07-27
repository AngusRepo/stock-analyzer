import assert from 'node:assert/strict'
import fs from 'node:fs'

const batch = fs.readFileSync('src/lib/s12DurableStructureBatch.ts', 'utf8')
const runtime = fs.readFileSync('src/lib/s12RuntimeBars.ts', 'utf8')
const runner = fs.readFileSync('src/node-runner/s12StructureBatchJobMain.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const callback = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const formalEv = fs.readFileSync('../ml-controller/services/s12_formal_ev_continuation.py', 'utf8')

assert(batch.includes('fetchS12ResearchKbarsBatch'))
assert(batch.includes('await db.batch(chunk)'))
assert(batch.includes('coverage_passed'))
assert(batch.includes("source === 'historical_shadow'"))
assert(runtime.includes('/kbars/batch'))
assert(runner.includes("task: 's12-structure-batch'"))
assert(orchestrator.includes('S12_DURABLE_STRUCTURE_JOB_ENABLED'))
assert(orchestrator.includes("msg.type === 's12_structure_batch_complete'"))
assert(callback.includes("body.task === 's12-structure-batch'"))
assert(formalEv.includes('"potential_buy"'))
assert(formalEv.includes('"direct_execution_allowed": False'))
assert(!formalEv.includes('"action": "buy"'))
assert(!formalEv.includes('global_expected_return'))
assert(!formalEv.includes('rank_fallback'))
