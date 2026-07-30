import assert from 'node:assert/strict'
import * as fs from 'node:fs'

const reference = fs.readFileSync('src/lib/selectionReferenceEvidence.ts', 'utf8')
const repair = fs.readFileSync('src/lib/selectionReferenceRepair.ts', 'utf8')
const projection = fs.readFileSync('src/lib/priceHorizonProjection.ts', 'utf8')
const controlRoute = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const triggerRoute = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const domainTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const finalizer = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const runState = fs.readFileSync('src/lib/strategyLearningRunState.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const weeklyDag = fs.readFileSync('../frontend/src/components/observability/ExecutionChainPanel.tsx', 'utf8')
const schemaGenerator = fs.readFileSync('scripts/build-domain-schemas.mjs', 'utf8')

assert.match(reference, /resolveReferenceStockIds/)
assert.match(reference, /selection_reference_stock_identity_incomplete/)
assert.match(reference, /stock_id=CASE/)
assert.match(repair, /repairSelectionReferenceStockIdentities/)
assert.match(repair, /selection_reference_identity_repair_runs_v1/)
assert.match(domainTasks, /'selection-reference-identity-repair': async/)
assert.match(triggerRoute, /'selection-reference-identity-repair'/)

assert.match(projection, /price_horizon_v3_canonical_reference_identity/)
assert.match(projection, /loadCandidateSignalDates/)
assert.match(projection, /price_horizon_reference_identity_incomplete/)
assert.match(projection, /feature_contract_version=\?/)
assert.match(projection, /SELECTION_REFERENCE_CONTRACT_VERSION/)
assert.doesNotMatch(projection, /identifiedReferenceRows[\s\S]*INSERT INTO price_horizon_projection_status[\s\S]*price_horizon_reference_identity_incomplete/)
assert.match(projection, /const status = 'success'/)
assert.doesNotMatch(projection, /status === 'empty'/)

assert.match(controlRoute, /strategy_redundancy_oof/)
assert.match(controlRoute, /strategy-redundancy-oof-evidence-v1/)
assert.match(controlRoute, /payload\.production_selector !== false/)

const canonicalFinalizer = finalizer.slice(
  finalizer.indexOf('export async function finalizeStrategyLearningEvidenceV5'),
  finalizer.indexOf('export async function runStrategyLearningClosure'),
)
assert(canonicalFinalizer.indexOf('options.beforePromotion') > canonicalFinalizer.indexOf('materializeCanonicalSelectionLabelsV4'))
assert(canonicalFinalizer.indexOf('options.beforePromotion') < canonicalFinalizer.indexOf('const marginalEdge = await refreshStrategyMarginalEdgeV4'))
assert.match(finalizer, /ORDER BY CASE WHEN d\.date=\? THEN 0 ELSE 1 END, d\.date DESC/)
assert.match(finalizer, /priorityDate: options\.historicalPriorityDate/)
const directClosure = finalizer.slice(finalizer.indexOf('export async function runStrategyLearningClosure'))
assert.match(directClosure, /strategy_learning_direct_production_mutation_requires_evening_chain_audit/)
assert.match(directClosure, /allowPromotion: false/)
assert.match(directClosure, /persistPolicy: false/)
assert.match(directClosure, /calibrateThresholds: false/)

const strategyQueue = orchestrator.slice(
  orchestrator.indexOf("if (msg.type === 'strategy_learning_materialize')"),
  orchestrator.indexOf("if (msg.type === 'source_readiness_retry')"),
)
assert(strategyQueue.indexOf('auditEveningChainEvidenceClosure') < strategyQueue.indexOf("logSchedulerResult(env.KV, 'evening-chain'"))
assert.match(strategyQueue, /resolveExpectedMatureSignalDate/)
assert.match(strategyQueue, /historicalPriorityDate/)
assert.match(domainTasks, /evening_chain_evidence_closure_callback_missing/)
assert.match(domainTasks, /failStrategyLearningRun/)
assert.match(runState, /status='error'.*completed_at=NULL/s)
assert.match(strategyQueue, /finalizerAttemptId/)
assert.match(strategyQueue, /root chain blocked by strategy-learning evidence audit/)
assert.match(domainTasks, /manual-finalize/)
assert.match(domainTasks, /root chain blocked by strategy-learning evidence audit/)

const strategyEnqueue = postMarketChain.slice(
  postMarketChain.indexOf("results.push(await logChainedTask(env, ctx, 'strategy-learning'"),
  postMarketChain.indexOf('await logChainSummary', postMarketChain.indexOf("results.push(await logChainedTask(env, ctx, 'strategy-learning'")),
)
assert.match(strategyEnqueue, /critical: true/)
assert.match(postMarketChain, /waitingForQueuedStrategyLearning/)
assert.match(postMarketChain, /status = hasError \? 'error' : waitingForQueuedStrategyLearning \? 'running' : 'success'/)


const weekly = weeklyDag.slice(
  weeklyDag.indexOf("id: 'weekly'"),
  weeklyDag.indexOf("id: 'monthly'"),
)
assert.match(weekly, /id: 'weekly-validation'/)
assert.match(weekly, /id: 'weekly-research'/)
assert.match(weekly, /id: 'weekly-policy'/)
assert.match(weekly, /id: 'weekly-maintenance'/)
assert.match(weekly, /id: 'weekly-retrain'/)
assert.doesNotMatch(weekly, /\['weekly-optuna', 'sector-leaders'\],\s*\['adaptive-meta-policy-replay'\]/)

assert.match(schemaGenerator, /CREATE\(\?:\\s\+UNIQUE\)\?\\s\+INDEX/)
