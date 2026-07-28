import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync('migrations/0089_strategy_evaluability_and_atomic_replacement.sql', 'utf8')
const learning = readFileSync('src/lib/strategyLearning.ts', 'utf8')
const edge = readFileSync('src/lib/strategyMarginalEdgeV4.ts', 'utf8')
const runState = readFileSync('src/lib/strategyLearningRunState.ts', 'utf8')

assert(migration.includes('evaluable INTEGER NOT NULL DEFAULT 0'), 'legacy strategy decisions must fail closed')
assert(migration.includes('unavailable_decisions INTEGER NOT NULL DEFAULT 0'), 'daily projection must separate unavailable decisions')
assert(migration.includes('strategy_evidence_rebuild_runs_v5'), 'historical PIT rebuild requires a durable ledger')
assert(migration.includes('strategy_replacement_decisions_v5'), 'paired replacements require immutable decision evidence')
for (const id of [
  'stock_tech_s05_first_dry_pullback_v1',
  'stock_tech_s07_2b_false_break_reversal_v1',
  'stock_tech_s09_three_soldiers_base_breakout_v1',
  'stock_tech_s10_island_reversal_v1',
]) {
  assert(migration.includes(id), id + ' must be downgraded to observe/research')
}
assert(migration.includes("'stock_tech_s08_rsi2_risk_filter_v1'"), 'S8 needs a separate observe-only filter ID')
assert(migration.includes("'stock_tech_s12_multitimeframe_smc_reclaim_v2', 'strategy-spec-v1'"), 'S12 formal snapshot semantics need a new strategy ID with the supported schema version')
assert(!migration.includes("'strategy-spec-v2'"), 'migration must not create an unsupported StrategySpec schema version')

assert(learning.includes('assessStrategySpecEvaluability'), 'decision logging must classify evaluable vs unavailable')
assert(learning.includes('hydrateS12StrategyEvidence'), 'S12 must read formal intraday snapshot evidence')
assert(learning.includes('rebuildHistoricalStrategyEvidenceV5'), 'daily closure must own bounded PIT backlog reconstruction')
assert(learning.includes('maxDates: 2'), 'daily closure must drain history in bounded chunks')
assert(!learning.includes('d.strategy_status, d.alpha_bucket, d.context_json, d.evidence_json'), 'historical decision query must not duplicate large JSON per strategy row')
assert(learning.includes('GROUP BY d.symbol'), 'historical context must be loaded once per symbol')
assert(learning.includes('evidence_json=json_patch'), 'historical evidence must merge in D1 without a read-modify-write payload')
const historicalRebuild = learning.slice(learning.indexOf('export async function rebuildHistoricalStrategyEvidenceV5'), learning.indexOf('export async function finalizeStrategyLearningEvidenceV5'))
assert(historicalRebuild.includes('new Map(referenceRows.map'), 'raw reference lineage must be deduplicated by symbol after validation')
assert(!historicalRebuild.includes('JOIN selection_reference_snapshots_v1 r'),
  'reference membership must use EXISTS so duplicate snapshots cannot multiply decision rows')
assert(runState.includes('priorCanonicalSuccess'), 'completed historical runs need a frozen lineage fast path')
assert(runState.includes('completed_at=CASE'), 'a new producer run must clear stale completion provenance')
assert(runState.indexOf('priorCanonicalSuccess') < runState.indexOf('JOIN strategy_spec_registry'),
  'historical completion provenance must be evaluated before current-registry coverage')

assert(edge.includes('const MIN_EDGE_DATES = 10'), 'strategy edge and learning gates must both require ten dates')
assert(edge.includes('evaluatePairedStrategyReplacementsV5'), 'promotion must use paired one-in-one-out evaluation')
assert(edge.includes("SET status='candidate', promotion_status='candidate'"), 'accepted promotion must demote the paired incumbent')
assert(edge.includes('production_owner_count_before'), 'cutover evidence must prove active count stability')
assert(edge.includes('no_hard_top_k: true'), 'replacement must remain edge-gated, not top-K')
assert(edge.includes('promotionAllowed = options.allowPromotion === true'), 'historical reruns must remain shadow-only')
assert(edge.includes('pair_conflict_or_lower_paired_edge'), 'non-selected passing pairs need an explicit rejection reason')
assert(edge.includes('strategy_replacement_cutover_guards_v5'), 'cutover batch needs transactional pre/post assertions')
assert(edge.includes('servingCoverageComplete'), 'registry and serving owner sets must match before promotion')
assert(edge.includes('for (const key of registryActiveKeys)'), 'first V5 artifact must bootstrap current registry owners, not union historical PIT owners')
assert(edge.includes("existing?.status === 'promoted'"), 'repeating the same promoted evidence run must be idempotent')
assert(migration.includes('CHECK(precondition_ok=1)'), 'failed cutover assertions must roll back the D1 batch')

const orchestrator = readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert(orchestrator.includes('finalizeStrategyLearningEvidenceV5'), 'production queue must use the canonical strategy finalizer')
assert(orchestrator.includes('Boolean(msg.force) && triggerTime === twToday()'), 'force cannot promote a historical business date')
assert(orchestrator.includes('allowPromotion: currentBusinessDateRun'), 'only the current business-date queue may cut over production owners')

console.log('strategyReplacementClosureV5 contract tests passed')
