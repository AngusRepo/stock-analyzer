const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const migration = fs.readFileSync('migrations/0063_allocator_ev_daily_lifecycle.sql', 'utf8')
const lifecycle = fs.readFileSync('src/lib/allocatorEvDailyLifecycle.ts', 'utf8')
const postMarket = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const controllerResearch = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const adminReadRoutes = fs.readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
const dashboardReadRoutes = fs.readFileSync('src/routes/dashboardReadRoutes.ts', 'utf8')

const fusionArtifactBuilder = fs.readFileSync('../ml-controller/services/allocator_ev_fusion_artifact_builder.py', 'utf8')
assert(migration.includes('allocator_ev_daily_lifecycle'), 'daily allocator EV lifecycle must be durable in D1')
assert(lifecycle.includes('inspectAllocatorSnapshotClosure'), 'watchdog must verify snapshot readback')
assert(!lifecycle.includes('recoverCompletedS12DurableCallback'), 'watchdog must not revive retired S12 serving callbacks')
assert(!lifecycle.includes("type: 's12_structure_batch_complete'"), 'watchdog must not enqueue retired S12 serving finalizers')
assert(orchestrator.includes("if (msg.type === 's12_structure_batch_complete')"), 'legacy S12 completion messages must remain drainable during cutover')
assert(orchestrator.includes('drained without pipeline continuation'), 'legacy S12 completion messages must have no serving side effects')
assert(lifecycle.includes('inspectAllocatorEvMaturityCoverage'), 'watchdog must expose strict expected-return maturity coverage')
assert(lifecycle.includes("'$.l4_alpha_ev.artifact_contract_version'"), 'L4 PIT maturity must require the current artifact contract')
assert(lifecycle.includes("'$.l4_alpha_ev.point_in_time_prediction_lineage.schema_version'"), 'L4 PIT maturity must require explicit point-in-time lineage')
assert(lifecycle.includes('incompatibleOrLegacyL4Rows'), 'legacy L4 snapshot rows must stay visible and outside strict maturity')
assert(lifecycle.includes('active8_oof_materialized_artifacts'), 'maturity must include checksum-indexed GCS L4 evidence')
assert(lifecycle.includes("a.artifact_kind = 'l4_predictions'"), 'indexed maturity must only count L4 prediction artifacts')
assert(lifecycle.includes("c.status = 'ready'"), 'indexed maturity must reject non-ready OOF cohorts')
assert(lifecycle.includes('active8_oof_forward_extension_coverage'), 'maturity must include verified frozen-forward monitoring coverage')
assert(lifecycle.includes("f.policy_version = 'verified-frozen-forward-monitoring-v2'"), 'shadow maturity must enforce the frozen-forward policy')
assert(lifecycle.includes('ORDER BY a.max_date DESC'), 'base maturity must select by evidence date, not write time')
assert(lifecycle.includes('indexedL4PitBaseMaxDate'), 'maturity must expose base and effective OOF dates separately')
assert(lifecycle.includes('Math.max(nativeStrictL4PitRows, indexedL4PitRows)'), 'maturity must not double-count native and indexed L4 evidence')
assert(adminReadRoutes.includes('/api/admin/expected-return/serving-state'), 'admin API must expose canonical expected-return owner and PIT maturity')
assert(dashboardReadRoutes.includes('/api/dashboard/v4/expected-return/status'), 'dashboard API must use the same expected-return serving truth')
assert(lifecycle.includes('runNativeLineageRows === expectedRows'), 'native daily snapshot closure must reject silently skipped lineage rows')
assert(lifecycle.includes('canonicalRecommendations.reduce<string | null>'), 'snapshot closure must observe the latest upstream recommendation generation')
assert(lifecycle.includes('MAX(generated_at) AS max_generated_at'), 'snapshot closure must observe the latest published snapshot generation')
assert(lifecycle.includes('snapshotFresh'), 'a stale snapshot from an earlier same-date pipeline run must not satisfy closure')
assert(lifecycle.includes('selection_reference_snapshots_v1'), 'snapshot closure must share the immutable selection-reference cohort with the producer')
assert(lifecycle.includes('canonical_run_heads'), 'snapshot closure must only accept the canonical screener run')
assert(lifecycle.includes("json_extract(score_components, '$.version') = 'score_v2'"), 'later filtered recommendation projections must not redefine the canonical learning cohort')
assert(lifecycle.includes('COALESCE(dr.stock_id, st.id) AS stock_id') && lifecycle.includes('causalPredictionStockIds.has(String(row.stock_id))'), 'snapshot closure must resolve filtered placeholder identities the same way as the producer')
assert(lifecycle.includes("import { nextTwTradingDate } from './schedulerPolicy'"), 'native lineage readback must share the canonical TWSE calendar owner')
assert(lifecycle.includes('nextSessionOpenUtc = `${nextSessionDate}T01:00:00.000Z`'), 'historical lineage must resolve the exact next-session open boundary')
assert(lifecycle.includes('datetime(generated_at) < datetime(?)'), 'native lineage readback must enforce prediction creation before next-session open')
assert(!lifecycle.includes('WITH next_executable_session AS'), 'historical lineage must not wait for a future 0050 close row before accepting a pre-open prediction')
assert(postMarket.match(/allowPointInTimeReconstruction: true/g)?.length === 2, 'post-pipeline may accept only its explicit PIT backfill for operational evidence closure')
assert(postMarket.match(/kv: env\.KV/g)?.length === 2, 'post-pipeline snapshot checks must use the canonical calendar owner')
assert(lifecycle.includes('allocator_ev_missing_point_in_time_lineage'), 'recommendations without legal immutable prediction lineage must fail visibly')
assert(lifecycle.includes('reconstructedLineageRows === 0'), 'native daily snapshot closure must not accept reconstructed lineage')
assert(lifecycle.includes('rejectedLineageRows === 0'), 'native daily snapshot closure must not accept rejected lineage')
assert(lifecycle.includes('allowPointInTimeReconstruction'), 'explicit historical backfill must have a separate reconstructed-lineage closure mode')
assert(lifecycle.includes('runNativeLineageRows + reconstructedLineageRows === expectedRows'), 'historical closure must account for every published row with real lineage')
assert(lifecycle.includes('recommendationRows === expectedRows'), 'snapshot closure must cover the complete recommendation cohort')
assert(lifecycle.match(/Number\(lineage\?\.row_count \?\? 0\) === expectedRows/g)?.length === 1, 'only native closure may require same-run native prediction lineage')
assert(lifecycle.match(/&& rejectedLineageRows === 0/g)?.length === 2, 'native and reconstructed closure must both reject incomplete lineage')
assert(controllerResearch.includes('allowPointInTimeReconstruction: true'), 'explicit research backfill may opt into reconstructed closure')
assert(controllerResearch.includes('kv: env.KV'), 'explicit backfill closure must use the canonical calendar owner')
assert(lifecycle.match(/allowPointInTimeReconstruction: true/g)?.length === 1, 'watchdog must inspect reconstructed operational closure once before durable recovery')
assert(lifecycle.includes('inspectAllocatorEvRecoveryUpstreamGate(env.KV, businessDate)'), 'watchdog must read canonical upstream scheduler evidence before recovery')
assert(lifecycle.includes('pipeline_ml_run_id_mismatch'), 'watchdog must fence stale ML evidence from a different pipeline run')
assert(lifecycle.includes('root_pipeline_run_id_mismatch'), 'watchdog must fence matching stale pipeline/ML evidence under a newer root run')
assert(lifecycle.includes('active_model_closure=true'), 'watchdog must require explicit active-model symbol closure')
assert(lifecycle.includes("historicalLearningLineageDecision(env.DB, env.KV, 'evening-chain', businessDate)"), 'watchdog repair window must use the canonical next-session-open boundary')
assert(!lifecycle.includes('businessDate < twTodayDate()'), 'midnight rollover alone must not close the allocator repair window')
assert(lifecycle.includes('runId: recoveryRunId') && lifecycle.includes('expectedCanonicalRunId: recoveryRunId') && !lifecycle.slice(lifecycle.indexOf('const recoveryRunId')).includes('adoptRunIdOnResume: true'), 'recovery must resume only the already-canonical verified pipeline run')
assert(
  lifecycle.indexOf('inspectAllocatorEvRecoveryUpstreamGate(env.KV, businessDate)')
    < lifecycle.indexOf("const { queuePostPipelineStage }"),
  'upstream closure gate must run before the watchdog can enqueue post-pipeline recovery',
)
assert(lifecycle.includes('queuePostPipelineStage(env') && lifecycle.includes('attempt: recoveryAttempt'), 'watchdog recovery must enqueue the durable post-pipeline owner with the stage retry attempt')
assert(
  lifecycle.includes('verifyCanonicalRunId !== lifecycleRunId')
    && lifecycle.includes('expectedCanonicalRunId: lifecycleRunId')
    && lifecycle.includes("stage: 'verify_v2'")
    && lifecycle.includes('cursorKey: verifyCursorKey'),
  'watchdog post-verify recovery must require exact lifecycle canonical plus verify producer cursor authority',
)
assert(fusionArtifactBuilder.includes('generation_mode == "native"'), 'Fusion promotion must remain native-lineage only')
assert(fusionArtifactBuilder.includes('native_rows == published_rows'), 'Fusion promotion must require complete native rows')
assert(fusionArtifactBuilder.includes('reconstructed_rows == 0'), 'Fusion promotion must reject reconstructed rows')
assert(lifecycle.includes("state !== 'verify_triggered'"), 'watchdog must detect stale verify callbacks')
assert(!lifecycle.includes('status: postPipelineStatus'), 'watchdog must not enqueue recovery and immediately mark/check it in the same request')
assert(lifecycle.includes('Number(lifecycle?.attempt_count ?? 0)'), 'snapshot retry budget must use the state-scoped lifecycle counter')
assert(!lifecycle.includes('Number(postPipelineStage?.attempt_count ?? 1)'), 'generic stage routing failures must not consume the snapshot retry budget')
assert(lifecycle.includes('postPipelineReached') && lifecycle.includes("status: 'success'"), 'snapshot-ready downstream lifecycle must reconcile stale post-pipeline errors')
assert(lifecycle.includes('callbackGraceActive'), 'watchdog must respect the durable callback grace window')
assert(lifecycle.includes('stageAgeMs < 15 * 60_000'), 'watchdog callback grace must be bounded to fifteen minutes')
assert(lifecycle.includes('stageLeaseLive'), 'watchdog callback grace must not protect an expired running lease')
assert(lifecycle.includes("postPipelineStage?.status !== 'running' || stageLeaseLive"), 'expired running callbacks must be recoverable immediately')
assert(lifecycle.includes('allocator EV lifecycle awaiting durable callback'), 'watchdog must report an in-flight callback instead of racing recovery')
assert(lifecycle.includes("excluded.state = 'replay_pending_maturity'"), 'replay queue must be able to return to stock-specific maturity waiting')
assert(lifecycle.includes('MAX(prediction_date) AS business_date'), 'cross-midnight watchdog must follow the latest native lineage date')
assert(lifecycle.includes("WHERE state = 'replay_pending_maturity'"), 'watchdog must revisit older replay cohorts waiting for five sessions')
assert(lifecycle.includes("last_error LIKE 'terminal market-data source error:%'"), 'watchdog must retry quota-blocked replay after the next post-market window')
assert(lifecycle.includes("datetime(updated_at) <= datetime('now', '-12 hours')"), 'quota recovery must not poll repeatedly in the same exhausted window')
assert(lifecycle.includes('coverage.matureMissingRows > 0'), 'watchdog must distinguish mature replay work from legitimate waiting')
assert(lifecycle.includes("type: 's12_replay_backfill_chunk'"), 'mature pending lifecycle rows must enqueue replay directly')
assert(lifecycle.includes('maturityAsOfDate'), 'replayed historical cohorts must use the current maturity knowledge date')
assert(
  lifecycle.includes('allocator EV native snapshot repair window closed for historical date='),
  'watchdog must not repeatedly mutate an incomplete historical native snapshot after its legal repair window closed',
)
assert(postMarket.includes("state: 'lineage_ready'"), 'native lineage must open the lifecycle')
assert(postMarket.includes("state: 'snapshot_ready'"), 'snapshot readback must precede verify')
assert(postMarket.indexOf("state: 'snapshot_ready'") < postMarket.indexOf("state: 'verify_triggered'"), 'snapshot must precede verify')
assert(postMarket.includes("state: 'replay_pending_maturity'"), 'daily lifecycle must wait for five-session replay maturity')
assert(postMarket.includes("type: 'allocator_ev_lifecycle_recovery'"), 'snapshot failure must enqueue bounded recovery')
assert(controllerResearch.includes('allocator EV feature snapshot readback incomplete'), 'all persisted snapshot callers must fail incomplete readback')
assert(controllerResearch.includes("state: 'snapshot_ready'"), 'manual and scheduled snapshot callers must durably advance lifecycle state')
assert(orchestrator.includes("state: 'replay_complete'"), 'final replay chunk must close the signal-date lifecycle')
assert(orchestrator.includes('remainingReplaySymbols.length === 0'), 'replay lifecycle must verify no cohort symbols remain before closure')
assert(orchestrator.includes('replayCoverage.replayRows === replayCoverage.totalSnapshotRows'), 'replay lifecycle must require full snapshot cohort outcome coverage')
assert(orchestrator.includes('replayCoverage.pendingMaturityRows === 0'), 'replay lifecycle must not close while stock-specific sessions are immature')
assert(orchestrator.includes('waiting_for_replay_maturity='), 'stock-specific replay maturity must remain observable')
assert(orchestrator.includes('waiting_for_replay_data='), 'incomplete replay data must remain observable and retryable')
assert(orchestrator.includes("status: hasMore ? 'running' : replayClosed ? 'success' : 'skipped'"), 'only an actually requeued S12 chunk may remain running')
assert(orchestrator.includes('dynamicCohortStalled'), 'dynamic replay must detect a zero-persistence no-progress loop')
assert(orchestrator.includes('requeue=0'), 'terminal market-data failures must not self-requeue and exhaust broker quota')

assert(
  lifecycle.indexOf("const learningDb = databaseForDataDomain(env, 'learning')")
    < lifecycle.indexOf('resolveLifecycleBusinessDate(learningDb, requestedDate)') &&
    !lifecycle.includes('resolveLifecycleBusinessDate(env.DB, requestedDate)'),
  'EV lifecycle business date must be resolved from Learning D1, never the retired legacy DB mirror',
)
assert(
  lifecycle.includes('status=pending allocator EV lifecycle awaiting durable callback') &&
    lifecycle.includes("status=${lifecycleComplete ? 'success' : 'pending'}") &&
    lifecycle.includes("lifecycle?.state === 'replay_complete'") &&
    lifecycle.includes("lifecycle_complete=${lifecycleComplete ? 1 : 0}"),
  'EV lifecycle must only report success for replay_complete and keep maturity/callback states pending',
)
assert(
  lifecycle.includes('status=triggered allocator EV lifecycle replay enqueued') &&
    lifecycle.includes('status=triggered allocator EV lifecycle recovered post-verify') &&
    lifecycle.includes('status=triggered allocator EV lifecycle recovery queued') &&
    lifecycle.includes('status=failed allocator EV lifecycle post-verify authority mismatch'),
  'EV lifecycle watchdog summaries must expose triggered and failed outcomes to the canonical scheduler classifier',
)
