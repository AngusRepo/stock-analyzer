import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync('migrations/0089_strategy_evaluability_and_atomic_replacement.sql', 'utf8')
const migration0090 = readFileSync('migrations/0090_daily_technical_strategy_producer_closure.sql', 'utf8')
const canonicalLineageMigration = readFileSync(
  'domain-migrations/learning/0036_strategy_evidence_v5_canonical_lineage.sql',
  'utf8',
)
const learning = readFileSync('src/lib/strategyLearning.ts', 'utf8')
const edge = readFileSync('src/lib/strategyMarginalEdgeV4.ts', 'utf8')
const runState = readFileSync('src/lib/strategyLearningRunState.ts', 'utf8')
const orchestrator = readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const historicalArtifact = readFileSync('src/lib/historicalScreenerArtifactEvidence.ts', 'utf8')
const routeRecovery = readFileSync('src/lib/strategyRouteRecoveryPacket.ts', 'utf8')
const adminTasks = readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const selectionEvidence = readFileSync('src/lib/selectionReferenceEvidence.ts', 'utf8')
const adminWrite = readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')
const routes = readFileSync('src/routes/other.ts', 'utf8')

assert(migration.includes('evaluable INTEGER NOT NULL DEFAULT 0'), 'legacy strategy decisions must fail closed')
assert(migration.includes('unavailable_decisions INTEGER NOT NULL DEFAULT 0'), 'daily projection must separate unavailable decisions')
assert(migration.includes('strategy_evidence_rebuild_runs_v5'), 'historical PIT rebuild requires a durable ledger')
assert(migration0090.includes('ADD COLUMN evaluation_contract_version TEXT'), 'rebuild ledger must distinguish pre-v2 success from valid v2 reconstruction')
for (const column of [
  'producer_run_id',
  'source_reference_contract_version',
  'production_policy_id',
  'production_policy_knowledge_cutoff_date',
  'production_policy_checksum',
  'production_policy_source_contract',
]) {
  assert(canonicalLineageMigration.includes(`ADD COLUMN ${column} TEXT`), `${column} must be durable formal-ledger lineage`)
}
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
assert(learning.includes('drainHistoricalStrategyEvidenceV5'), 'critical finalizer must drain the bounded live PIT frontier')
assert(learning.includes('formal_strategy_evidence_backlog_not_drained'), 'critical finalizer must fail closed while formal backlog remains')
assert(!learning.includes('d.strategy_status, d.alpha_bucket, d.context_json, d.evidence_json'), 'historical decision query must not duplicate large JSON per strategy row')
assert(learning.includes('GROUP BY d.symbol'), 'historical context must be loaded once per symbol')
assert(learning.includes('historicalCandidateBySymbol'), 'historical raw-signal derivation must be memoized once per symbol')
assert(learning.includes('evidence_json=json_patch'), 'historical evidence must merge in D1 without a read-modify-write payload')
const historicalSelector = learning.slice(learning.indexOf('export async function listHistoricalStrategyEvidenceV5Dates'), learning.indexOf('export async function rebuildHistoricalStrategyEvidenceV5'))
assert(historicalSelector.indexOf('if (options.priorityOnly)') < historicalSelector.indexOf('WITH source_dates'),
  'standalone single-date maintenance must return before the live-frontier CTE')
assert(historicalSelector.includes('FROM strategy_label_matrix_runs_v4')
  && historicalSelector.includes('STRATEGY_EVIDENCE_V5_LIVE_FRONTIER_START_DATE'),
  'live backlog discovery must use canonical matrix dates and the explicit v5 closure epoch')
const historicalRebuild = learning.slice(learning.indexOf('export async function rebuildHistoricalStrategyEvidenceV5'), learning.indexOf('export async function finalizeStrategyLearningEvidenceV5'))
assert(
  historicalRebuild.includes("'strategy-labeler-v1'")
    && historicalRebuild.includes('strategy_matrix_source_labeler_unsupported')
    && historicalRebuild.includes('source_labeler_version: referenceLabeler')
    && historicalRebuild.includes('output_labeler_version: labelerVersion'),
  'historical reconstruction must accept the exact lineage-bound v1 matrix only as input and emit explicit formal reconstruction lineage',
)
assert(
  !historicalRebuild.includes('legacy_strategy_matrix_pit_unavailable'),
  'legacy source identity must not circularly block PIT reconstruction when immutable candidate contexts are complete',
)
assert(historicalSelector.includes('FROM json_each(?) h')
  && !historicalSelector.includes('FROM canonical_run_heads h'),
  'historical date selection must receive canonical screener authority from Ops instead of querying an Ops table in Learning D1')
assert(historicalRebuild.includes('r.producer_run_id=?')
  && !historicalRebuild.includes('FROM canonical_run_heads h'),
  'historical rebuild must bind the Ops-resolved canonical producer instead of cross-querying canonical_run_heads')
assert(historicalRebuild.includes("productionPolicySourceLabeler === 'strategy-labeler-v1'"),
  'legacy label reconstruction must select the immutable v1 prior-policy identity explicitly')
assert(historicalRebuild.includes('resolveLegacyImplicitUnitWeightsBeforeFirewall')
  && historicalRebuild.includes('production_weight_source: productionWeightEvidence')
  && historicalRebuild.includes("productionPolicySourceLabeler === 'strategy-labeler-v1'"),
  'pre-firewall v1 reconstruction may use only the source-commit-bound implicit unit-weight contract and must persist its provenance')

assert(historicalRebuild.includes("referenceLabeler === 'strategy-decision-log-pit-reconstruction-v6'")
  && historicalRebuild.includes("artifactEvidence?.source_labeler_version === 'strategy-labeler-v1'")
  && historicalRebuild.includes('artifactEvidence.expected_cell_count !== expectedMatrixRows')
  && historicalRebuild.includes('!artifactBackedV1Carrier'),
  'a v6 carrier may be rebuilt only from an exact immutable v1 artifact with full matrix coverage')
assert(historicalArtifact.includes("p.canonical_at IS NOT NULL")
  && historicalArtifact.includes("a.payload_deleted_at IS NULL")
  && historicalArtifact.includes("await sha256(body) !== row.checksum")
  && historicalArtifact.includes("sourceLabeler !== HISTORICAL_SCREENER_ARTIFACT_SOURCE_LABELER")
  && historicalArtifact.includes('expectedCellCount !== candidateCount * strategyCount')
  && historicalArtifact.includes('coverageRatio !== 1'),
  'artifact recovery must verify past canonical status, retained payload, checksum, v1 labeler, and exact matrix coverage')
assert(historicalRebuild.includes('includeRetired: true')
  && historicalRebuild.includes('historicalStatusByKey')
  && historicalRebuild.includes('status: historicalStatusByKey.get'),
  'historical reconstruction must load retired registry lineage and restore the immutable decision-date status')
assert(historicalSelector.includes("r.status <> 'success'")
  && historicalSelector.includes("COALESCE(r.labeler_version, '') <>"),
  'live-frontier drain must reopen every non-success or stale-contract ledger row')
assert(historicalSelector.includes("COALESCE(r.producer_run_id, '') <> d.producer_run_id")
  && historicalSelector.includes("COALESCE(r.production_policy_id, '') = ''")
  && historicalSelector.includes("length(COALESCE(r.production_policy_checksum, '')) <> 64"),
  'live-frontier drain must reopen success rows whose canonical producer or PIT policy lineage is absent')
assert(!historicalRebuild.includes(".filter((spec) => spec.status !== 'retired')\n        .map((spec) => spec.id)"),
  'historical production weights must cover the decision-date strategy universe, including later-retired IDs')

assert(orchestrator.includes('loadHistoricalScreenerArtifactEvidence')
  && adminTasks.includes('loadHistoricalScreenerArtifactEvidence'),
  'queue and manual finalizers must use the same immutable artifact verifier')
assert(historicalRebuild.includes('applyStrategyRouteRecoveryScores')
  && routeRecovery.includes('route_recovery_coverage_mismatch')
  && routeRecovery.includes('route_recovery_carrier_conflict')
  && routeRecovery.includes('strategy_challenger_route_score: recovery.challenger_route_score'),
  'verified immutable route packet must repair missing scores and reject conflicting carriers before CAS persistence')
assert(historicalRebuild.includes('loadLegacyStrategyProductionWeightsBefore'),
  'legacy policy compatibility must remain scoped to historical reconstruction, never runtime serving')
assert(historicalRebuild.includes('loadStrategyProductionPolicyForHistoricalReconstructionBefore')
  && historicalRebuild.includes('reconstruction_receipt'),
  'owner-v2 compatibility must be checksum-verified and scoped to historical reconstruction')
assert(historicalRebuild.includes('production_policy_knowledge_cutoff_date=?')
  && historicalRebuild.includes('strategy_production_policy_lineage_incomplete'),
  'formal success must persist and validate the exact PIT production-policy lineage')
assert(historicalRebuild.includes('SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION')
  && historicalRebuild.includes('legacyMatureCarrier')
  && historicalRebuild.includes('sourceReferenceContractVersion'),
  'legacy v3 selection carriers need explicit lineage and coverage verification')
assert(historicalRebuild.includes('new Map(referenceRows.map'), 'raw reference lineage must be deduplicated by symbol after validation')
assert(historicalRebuild.includes("cleanToken(row.evaluation_contract_version) !== 'strategy-evaluation-v2'"),
  'historical retries must skip decision rows already reconstructed under the V2 evaluation contract')
assert(historicalRebuild.includes("cleanToken(row.evaluability_status) === 'UNKNOWN_LEGACY'"),
  'historical retries must still repair legacy rows whose evaluability remains unknown')
assert(!historicalRebuild.includes('JOIN selection_reference_snapshots_v1 r'),
  'reference membership must use EXISTS so duplicate snapshots cannot multiply decision rows')
assert.equal((historicalRebuild.match(/r\.hard_gate_passed=1/g) ?? []).length, 3,
  'reference, decision, and context sets must share the canonical L0 hard-gate predicate')
assert(orchestrator.includes('loadCanonicalScreenerRunIds')
  && adminTasks.includes('loadCanonicalScreenerRunIds')
  && adminWrite.includes('loadCanonicalScreenerRunIds'),
  'queue, finalizers, and admin dry-runs must resolve canonical screener authority from Ops D1')
assert(orchestrator.includes("msg.type === 'strategy_evidence_rebuild'")
  && orchestrator.includes('priorityOnly: true')
  && orchestrator.includes('report.successfulDates !== 1 || report.blockedDates !== 0'),
  'explicit maintenance rebuild queues must fully validate exactly the requested canonical date')
assert(historicalRebuild.includes('persistSelectionEvidenceV4')
  && !historicalRebuild.includes('superseded_by_strategy_decision_log_pit_reconstruction_v5')
  && !historicalRebuild.includes("DELETE FROM strategy_label_matrix_v4 WHERE producer_run_id=?"),
  'historical replacement must use fenced staging/CAS and must not delete immutable ready carriers')
assert(historicalRebuild.includes('existingMatrixMatchedRows > 0'),
  'legacy ready matrix reuse must require matched strategy evidence')
assert(historicalRebuild.includes('existingMatrixThresholdEvidenceRows === existingMatrixMatchedRows'),
  'legacy ready matrix reuse must require complete threshold-margin evidence')
assert(learning.includes('repairHistoricalStrategyDecisionGrid')
  && learning.includes('historical_strategy_decision_grid_incomplete'),
  'missing decision grids must be rebuilt by the canonical producer and read back exactly')
assert(selectionEvidence.includes('reference_candidate_count=excluded.reference_candidate_count'),
  'matrix retry must replace stale run metadata with the current canonical universe')
assert(selectionEvidence.includes('FROM selection_reference_snapshots_v1 r')
  && selectionEvidence.includes('WHEN r.signal_date=? AND r.hard_gate_passed=1'),
  'reference persistence coverage must verify the complete canonical hard-gate contract')
assert(selectionEvidence.includes('FROM json_each(?)'),
  'matrix persistence must use bounded set-based JSON inserts instead of one D1 statement per row')
assert(selectionEvidence.includes('const matrixJsonChunkSize = 1000'),
  'matrix JSON inserts must remain bounded while keeping the reconstruction inside the execution budget')
assert(edge.includes("mr.status='ready'") && learning.includes("mr.status='ready'") && routes.includes("mr.status='ready'"),
  'Edge, reward, and UI consumers must reject partial matrix rebuilds')
assert(orchestrator.includes('reconcileStrategyLearningFinalizedRetryFastPath'), 'queued finalized runs need an idempotent fenced telemetry-repair fast path')
assert(adminTasks.includes('reconcileStrategyLearningFinalizedRetryFastPath'),
  'manual finalized runs need an idempotent fenced telemetry-repair fast path')
assert(runState.includes('completed_at=CASE'), 'a new producer run must clear stale completion provenance')

assert(edge.includes('const MIN_EDGE_DATES = 10'), 'strategy edge and learning gates must both require ten dates')
assert(edge.includes('STRATEGY_REPLACEMENT_POLICY_V7'), 'replacement thresholds need one exported V7 backend source of truth')
assert(edge.includes('const MIN_EFFECTIVE_PAIRED_DATES = 30'), 'overlapping T+5 outcomes need an effective-sample floor')
assert(learning.includes('STRATEGY_PROMOTION_THRESHOLDS'), 'promotion thresholds must be returned by the learning API')
assert(learning.includes('loadStrategyReplacementGateSummary'), 'Strategy Lab must load the latest immutable V7 replacement evidence')
assert(learning.includes("json_extract(evidence_json, '$.schema_version') = ?"), 'legacy replacement runs must not masquerade as V7 evidence')
assert(learning.includes("diagnostic_only_metrics: ['match_rate', 'hit_rate', 'avg_cost_net_alpha', 'max_drawdown', 'date_return_lcb90']"), 'absolute performance metrics must remain diagnostics outside Atomic V7 relative replacement')
assert(edge.includes("strategy-marginal-edge-v7"), 'HAC/Holm replacement semantics require a new immutable artifact contract')
assert(edge.includes('evaluatePairedStrategyReplacementsV7'), 'promotion must use paired HAC/Holm one-in-one-out evaluation')
assert(edge.includes('newey_west_bartlett'), 'overlapping outcomes require dependence-adjusted inference')
assert(edge.includes('holm_bonferroni'), 'candidate/incumbent trials require family-wise correction')
assert(edge.includes('candidate_absolute_cost_net_lcb95_hac_not_positive'), 'absolute profitability needs a cost-net HAC lower bound')
assert(edge.includes('l.outcome_known_date <= ?'), 'unknown future outcomes must be excluded at the run cutoff')
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
assert(edge.includes("eligible_owner.status IN ('active','candidate')"), 'replacement evidence must use only canonical Active/Candidate lifecycle rows')
assert(!edge.includes('candidate_and_shadow_strategies_evaluated'), 'replacement artifacts must not expose Shadow as a strategy stage')
assert(edge.includes("replacementScope: 'same_family' | 'cross_family'"), 'cross-family replacement must be explicit evidence, not an implicit family bypass')
assert(edge.includes('cross_family_requires_full_portfolio_gates: true'), 'cross-family cutover must preserve full portfolio risk gates')
assert(edge.includes('globalCorrelationPass') && edge.includes('globalTurnoverPass'), 'portfolio correlation and turnover must gate every replacement set')
assert(edge.includes('for (const key of registryActiveKeys)'), 'first V5 artifact must bootstrap current registry owners, not union historical PIT owners')
assert(edge.includes("existing?.status === 'promoted'"), 'repeating the same promoted evidence run must be idempotent')
assert(migration.includes('CHECK(precondition_ok=1)'), 'failed cutover assertions must roll back the D1 batch')

assert(orchestrator.includes('finalizeStrategyLearningEvidenceV5'), 'production queue must use the canonical strategy finalizer')
assert(learning.includes('strategy_learning_finalizer_stage_failed:'), 'finalizer failures must persist the exact failed stage')
assert(!learning.includes("'threshold_calibration'"), 'retired Threshold calibrator must not remain a parallel finalizer owner')
assert(learning.includes("'route_calibration'"), 'route calibration must retain its distinct evidence-stage failure owner')
assert(learning.includes("'adaptive_policy'"), 'adaptive policy must have a distinct finalizer failure owner')
assert(orchestrator.includes('resolveEveningChainRunAuthority'), 'queue finalizer must revalidate durable canonical production authority')
assert(orchestrator.includes('productionAuthority?.allowed === true'), 'production mutation must require resolved authority')
assert(orchestrator.includes('durable_run_not_marked_production_eligible'), 'shadow reruns must remain fail-closed without durable production-authority intent')
assert(orchestrator.includes('productionAuthorityIntent && !currentBusinessDateRun'), 'a live-intent run must fail rather than downgrade silently when authority is denied')
assert(orchestrator.includes('policyMutationAllowed = productionAuthorityIntent && currentBusinessDateRun'), 'production policy mutation must require both durable live intent and current canonical authority')
assert(orchestrator.includes('allowPromotion: policyMutationAllowed'), 'evidence-only recovery must close live lineage without cutting over production owners')

console.log('strategyReplacementClosureV5 contract tests passed')
