import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const orchestrator = readFileSync(new URL('./updateOrchestrator.ts', import.meta.url), 'utf8')
const candidateSnapshots = readFileSync(new URL('./s12CandidateStructureSnapshots.ts', import.meta.url), 'utf8')
const persistence = readFileSync(new URL('./s12StructureSnapshots.ts', import.meta.url), 'utf8')
const types = readFileSync(new URL('../types.ts', import.meta.url), 'utf8')

assert.match(types, /\| 's12_candidate_snapshot_chunk'/)
assert.match(orchestrator, /const S12_CANDIDATE_SNAPSHOT_CHUNK_SIZE = 5/)
assert.match(orchestrator, /const S12_CANDIDATE_SNAPSHOT_RESEARCH_TIMEOUT_MS = 10_000/)
assert.match(orchestrator, /researchTimeoutMs: S12_CANDIDATE_SNAPSHOT_RESEARCH_TIMEOUT_MS/)
assert.match(orchestrator, /if \(msg\.type === 's12_candidate_snapshot_chunk'\)/)
assert.match(orchestrator, /cursorKey: ''/)
assert.match(orchestrator, /cursorKey,\s*triggerTime, runId, attempt: 1/)
assert.match(orchestrator, /pendingRunId: runId/)
assert.match(orchestrator, /s\.pending_run_id=\?/)
assert.match(orchestrator, /persistedRows !== referenceRows/)
assert.match(orchestrator, /continuePostScreenerPipeline\(env, deps, triggerTime, runId, true\)/)
assert.doesNotMatch(
  orchestrator,
  /runS12CandidateStructureSnapshots\(env, triggerTime\)\s*$/m,
  'pre-pipeline must not process the full reference universe in one queue invocation',
)
assert.match(candidateSnapshots, /researchTimeoutMs\?: number/)
assert.match(candidateSnapshots, /loadS12HistoricalReplayBars\(targetEnv, targetSymbol, targetDate, \{/)

assert.match(candidateSnapshots, /AND r\.symbol > \?/)
assert.match(candidateSnapshots, /bind\(tradeDate, afterSymbol, cappedLimit \+ 1\)/)
assert.match(candidateSnapshots, /pendingRunId\?: string/)
assert.equal((candidateSnapshots.match(/pendingRunId: options\.pendingRunId/g) ?? []).length, 3)

assert.match(persistence, /pendingRunId\?: string \| number \| null/)
assert.match(persistence, /ON CONFLICT\(trade_date, symbol, source\) DO UPDATE SET/)
assert.match(persistence, /pending_run_id=excluded\.pending_run_id/)
