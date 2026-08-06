import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync('migrations/0089_strategy_evaluability_and_atomic_replacement.sql', 'utf8')
const migration0090 = readFileSync('migrations/0090_daily_technical_strategy_producer_closure.sql', 'utf8')
const learning = readFileSync('src/lib/strategyLearning.ts', 'utf8')
const edge = readFileSync('src/lib/strategyMarginalEdgeV4.ts', 'utf8')
const runState = readFileSync('src/lib/strategyLearningRunState.ts', 'utf8')
const selectionEvidence = readFileSync('src/lib/selectionReferenceEvidence.ts', 'utf8')
const routes = readFileSync('src/routes/other.ts', 'utf8')

assert(migration.includes('evaluable INTEGER NOT NULL DEFAULT 0'), 'legacy strategy decisions must fail closed')
assert(migration.includes('unavailable_decisions INTEGER NOT NULL DEFAULT 0'), 'daily projection must separate unavailable decisions')
assert(migration.includes('strategy_evidence_rebuild_runs_v5'), 'historical PIT rebuild requires a durable ledger')
assert(migration0090.includes('ADD COLUMN evaluation_contract_version TEXT'), 'rebuild ledger must distinguish pre-v2 success from valid v2 reconstruction')
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
assert(learning.includes('options.maxDates ?? 2'), 'maintenance callers must retain a bounded backlog drain default')
assert(learning.includes('maxDates: 1'), 'critical finalizer must repair at most one PIT date per invocation')
assert(learning.includes('priorityOnly: true'), 'critical finalizer must not block live closure on older maintenance backlog')
assert(!learning.includes('d.strategy_status, d.alpha_bucket, d.context_json, d.evidence_json'), 'historical decision query must not duplicate large JSON per strategy row')
assert(learning.includes('GROUP BY d.symbol'), 'historical context must be loaded once per symbol')
assert(learning.includes('evidence_json=json_patch'), 'historical evidence must merge in D1 without a read-modify-write payload')
const historicalSelector = learning.slice(learning.indexOf('export async function listHistoricalStrategyEvidenceV5Dates'), learning.indexOf('export async function rebuildHistoricalStrategyEvidenceV5'))
assert(historicalSelector.indexOf('if (options.priorityOnly)') < historicalSelector.indexOf('WITH decision_dates'),
  'priority-only live closure must return from the single-date ledger fast path before the full-history CTE')
const historicalRebuild = learning.slice(learning.indexOf('export async function rebuildHistoricalStrategyEvidenceV5'), learning.indexOf('export async function finalizeStrategyLearningEvidenceV5'))
assert(historicalRebuild.includes('new Map(referenceRows.map'), 'raw reference lineage must be deduplicated by symbol after validation')
assert(!historicalRebuild.includes('JOIN selection_reference_snapshots_v1 r'),
  'reference membership must use EXISTS so duplicate snapshots cannot multiply decision rows')
assert.equal((historicalRebuild.match(/r\.hard_gate_passed=1/g) ?? []).length, 3,
  'reference, decision, and context sets must share the canonical L0 hard-gate predicate')
assert(historicalRebuild.includes('superseded_by_strategy_decision_log_pit_reconstruction_v5'),
  'legacy ready matrices must be durably superseded before V5 replacement')
assert(historicalRebuild.includes('existingMatrixMatchedRows > 0'),
  'legacy ready matrix reuse must require matched strategy evidence')
assert(historicalRebuild.includes('existingMatrixThresholdEvidenceRows === existingMatrixMatchedRows'),
  'legacy ready matrix reuse must require complete threshold-margin evidence')
assert(selectionEvidence.includes('reference_candidate_count=excluded.reference_candidate_count'),
  'matrix retry must replace stale run metadata with the current canonical universe')
assert(selectionEvidence.includes('producer_run_id = ? AND hard_gate_passed = 1'),
  'reference persistence coverage must count the canonical hard-gate universe only')
assert(edge.includes("mr.status='ready'") && learning.includes("mr.status='ready'") && routes.includes("mr.status='ready'"),
  'Edge, reward, and UI consumers must reject partial matrix rebuilds')
assert(runState.includes('priorCanonicalSuccess'), 'completed historical runs need a frozen lineage fast path')
assert(runState.includes('completed_at=CASE'), 'a new producer run must clear stale completion provenance')
assert(runState.indexOf('priorCanonicalSuccess') < runState.indexOf('JOIN strategy_spec_registry'),
  'historical completion provenance must be evaluated before current-registry coverage')

assert(edge.includes('const MIN_EDGE_DATES = 10'), 'strategy edge and learning gates must both require ten dates')
assert(edge.includes('STRATEGY_REPLACEMENT_POLICY_V6'), 'replacement thresholds need one exported backend source of truth')
assert(learning.includes('STRATEGY_PROMOTION_THRESHOLDS'), 'promotion thresholds must be returned by the learning API')
assert(learning.includes('loadStrategyReplacementGateSummary'), 'Strategy Lab must load the latest immutable V6 replacement evidence')
assert(learning.includes("json_extract(evidence_json, '$.schema_version') = ?"), 'legacy replacement runs must not masquerade as V6 evidence')
assert(learning.includes("missing.push('max_drawdown_missing')"), 'candidate readiness must fail closed when drawdown evidence is absent')
assert(edge.includes("strategy-marginal-edge-v6"), 'cross-family replacement semantics require a new immutable artifact contract')
assert(edge.includes('evaluatePairedStrategyReplacementsV6'), 'promotion must use paired one-in-one-out evaluation')
assert(edge.includes("SET status='candidate', promotion_status='candidate'"), 'accepted promotion must demote the paired incumbent')
assert(edge.includes('production_owner_count_before'), 'cutover evidence must prove active count stability')
assert(edge.includes('no_hard_top_k: true'), 'replacement must remain edge-gated, not top-K')
assert(edge.includes('promotionAllowed = options.allowPromotion === true'), 'historical reruns must remain shadow-only')
assert(edge.includes('pair_conflict_or_lower_paired_edge'), 'non-selected passing pairs need an explicit rejection reason')
assert(edge.includes('strategy_replacement_cutover_guards_v5'), 'cutover batch needs transactional pre/post assertions')
assert(edge.includes('servingCoverageComplete'), 'registry and serving owner sets must match before promotion')
assert(!edge.includes("m.family_id <> 'SMC_STRUCTURE_RECLAIM'"), 'SMRC daily selection evidence must not be bypassed from owner coverage')
assert(edge.includes("eligible_owner.variant_id NOT LIKE 's12_%'"), 'S12 execution-owned evidence, including retired lineage, must remain outside selection replacement')
assert(edge.includes("variant_id NOT LIKE 's12_%'"), 'serving coverage must use the same explicit owner boundary as edge evaluation')
assert(edge.includes("eligible_owner.promotion_status <> 'retired'"), 'retired historical matrix rows must not re-enter replacement proposals')
assert(edge.includes("replacementScope: 'same_family' | 'cross_family'"), 'cross-family replacement must be explicit evidence, not an implicit family bypass')
assert(edge.includes('cross_family_requires_full_portfolio_gates: true'), 'cross-family cutover must preserve full portfolio risk gates')
assert(edge.includes('globalCorrelationPass') && edge.includes('globalTurnoverPass'), 'portfolio correlation and turnover must gate every replacement set')
assert(edge.includes('for (const key of registryActiveKeys)'), 'first V5 artifact must bootstrap current registry owners, not union historical PIT owners')
assert(edge.includes("existing?.status === 'promoted'"), 'repeating the same promoted evidence run must be idempotent')
assert(migration.includes('CHECK(precondition_ok=1)'), 'failed cutover assertions must roll back the D1 batch')

const orchestrator = readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert(orchestrator.includes('finalizeStrategyLearningEvidenceV5'), 'production queue must use the canonical strategy finalizer')
assert(learning.includes('strategy_learning_finalizer_stage_failed:'), 'finalizer failures must persist the exact failed stage')
assert(!learning.includes("'threshold_calibration'"), 'retired Threshold calibrator must not remain a parallel finalizer owner')
assert(learning.includes("'route_calibration'"), 'route calibration must retain its distinct evidence-stage failure owner')
assert(learning.includes("'adaptive_policy'"), 'adaptive policy must have a distinct finalizer failure owner')
assert(orchestrator.includes('resolveEveningChainRunAuthority'), 'queue finalizer must revalidate durable canonical production authority')
assert(orchestrator.includes('productionAuthority?.allowed === true'), 'production mutation must require resolved authority')
assert(orchestrator.includes('queue_not_marked_production_eligible'), 'shadow reruns must remain fail-closed without queue eligibility')
assert(orchestrator.includes('policyMutationAllowed = currentBusinessDateRun'), 'production policy mutation must start from live canonical authority')
assert(orchestrator.includes('allowPromotion: policyMutationAllowed'), 'evidence-only recovery must close live lineage without cutting over production owners')

console.log('strategyReplacementClosureV5 contract tests passed')
