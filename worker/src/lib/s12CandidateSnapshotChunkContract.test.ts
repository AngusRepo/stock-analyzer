import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const orchestrator = readFileSync(new URL('./updateOrchestrator.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('../types.ts', import.meta.url), 'utf8')

assert.match(types, /\| 's12_candidate_snapshot_chunk'/)
assert.match(orchestrator, /if \(msg\.type === 's12_candidate_snapshot_chunk'\)/)
assert.match(orchestrator, /Deprecated S12 candidate snapshot message drained without serving side effects/)
assert.doesNotMatch(
  orchestrator,
  /UPDATE_QUEUE\.send\(\{\s*type: 's12_candidate_snapshot_chunk'/m,
  'production evening chain must not enqueue new S12 candidate snapshot work',
)
assert.match(orchestrator, /if \(msg\.type === 's12_replay_backfill_chunk'\)/)
assert.match(orchestrator, /if \(msg\.type === 's12_research_recovery'\)/)
