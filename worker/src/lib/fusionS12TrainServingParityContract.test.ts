import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const replay = fs.readFileSync('src/lib/s12ReplayTradeOutcome.ts', 'utf8')
const runtimeBars = fs.readFileSync('src/lib/s12RuntimeBars.ts', 'utf8')
const bootstrap = fs.readFileSync('../ml-controller/services/s12_trade_ev_bootstrap.py', 'utf8')
const materializer = fs.readFileSync('../ml-controller/services/allocator_ev_fusion.py', 'utf8')
const builder = fs.readFileSync('../ml-controller/services/allocator_ev_fusion_artifact_builder.py', 'utf8')
const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')

assert(
  replay.includes("assessment.state === 'reaction_ready'") &&
    replay.includes('isEquityMutationReplayEntry(assessment)'),
  'replay must preserve full reaction and reduced-risk equity-mutation execution archetypes',
)
assert(
  bootstrap.includes('{"reaction_ready", "limited_takeover_ready"}'),
  'S12 direct EV serving must accept the same canonical long-entry states as replay',
)
assert(
  !materializer.includes('execution_model_applied = bool(execution_coefs) and s12_value is not None'),
  'direct S12 EV availability must not disable the learned two-part execution model',
)
assert(
  replay.includes("source: 's12_multisession_structure_replay_v3'") &&
    builder.includes("o.source = 's12_multisession_structure_replay_v3'") &&
    bootstrap.includes("r.source = 's12_multisession_structure_replay_v3'"),
  'replay persistence, Fusion labels, and S12 bootstrap must share the V3 source owner',
)
assert(
  runtimeBars.includes('loadS12HistoricalReplayLifecycleBars') &&
    replay.includes("exit_horizon_contract: 'up_to_five_stock_specific_sessions_after_entry'"),
  'next-session entry replay must continue through the five-session canonical exit horizon',
)
assert(
  builder.includes('failed_gates = [') &&
    builder.includes('(\"execution_probability\", execution_probability_model)') &&
    builder.includes('(\"final_champion\", champion_comparison)'),
  'top-level validation must aggregate every fitted expert and the final trade-EV champion comparison',
)
assert(
  postMarketChain.indexOf("'allocator-ev-feature-snapshot-backfill'") < postMarketChain.indexOf("'verify-v2'") &&
    postMarketChain.includes("if (snapshotTask.status === 'error')"),
  'same-date feature snapshots must be materialized after pipeline and fail closed before verify',
)
