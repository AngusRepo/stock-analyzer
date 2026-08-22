import assert from 'node:assert/strict'
import fs from 'node:fs'

const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const queueStart = orchestrator.indexOf("if (msg.type === 'strategy_learning_materialize')")
const queueEnd = orchestrator.indexOf("if (msg.type === 'source_readiness_retry')", queueStart)
const queueBlock = orchestrator.slice(queueStart, queueEnd)
assert.match(queueBlock, /const learningDb = databaseForDataDomain\(env, 'learning'\)/)
assert.match(queueBlock, /const opsDb = databaseForDataDomain\(env, 'ops'\)/)
assert.match(queueBlock, /const runStateDb = opsDb/)
assert.match(queueBlock, /loadCanonicalScreenerRunIds\(env, triggerTime\)/)
assert.match(queueBlock, /initializeStrategyLearningRun\(runStateDb,[\s\S]*universeDb: learningDb,[\s\S]*canonicalProducerRunId/)
assert.match(queueBlock, /materializeStrategyDecisionLogChunk\(learningDb,[\s\S]*candidateDb: opsDb,[\s\S]*candidateReferenceDb: learningDb,[\s\S]*recommendationDb: databaseForDataDomain\(env, 'core'\),[\s\S]*marketDb: databaseForDataDomain\(env, 'market'\),[\s\S]*canonicalProducerRunId: state\.producer_run_id/)

const domainRoutedFunctions = [
  'loadStrategyLearningRun',
  'seedDefaultStrategySpecRegistry',
  'listStrategySpecsForLearning',
  'initializeStrategyLearningRun',
  'claimStrategyLearningPage',
  'materializeStrategyDecisionLogChunk',
  'checkpointStrategyLearningPage',
  'completeStrategyLearningRun',
  'startStrategyLearningLeaseHeartbeat',
  'finalizeStrategyLearningEvidenceV5',
  'markStrategyLearningRunFinalized',
  'deferStrategyLearningFinalizer',
  'failStrategyLearningRun',
]
for (const name of domainRoutedFunctions) {
  assert.doesNotMatch(queueBlock, new RegExp(`${name}\\(env\\.DB`), `${name} must use the Learning binding`)
}

assert.match(queueBlock, /loadStrategyLearningRun\(runStateDb/)
assert.match(queueBlock, /markStrategyLearningRunFinalized\(runStateDb/)
assert.doesNotMatch(queueBlock, /(?:loadStrategyLearningRun|initializeStrategyLearningRun|claimStrategyLearningPage|checkpointStrategyLearningPage|completeStrategyLearningRun|startStrategyLearningLeaseHeartbeat|markStrategyLearningRunFinalized|deferStrategyLearningFinalizer|failStrategyLearningRun|reconcileStrategyLearningFinalizedRetryFastPath|reconcileAndReleaseStrategyLearningFinalizedTelemetry)\(\s*learningDb/, 'run state must not use Learning D1')

const manual = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const manualStart = manual.indexOf("'strategy-learning-finalize': async () =>")
const manualEnd = manual.indexOf("'selection-reference-identity-repair': async () =>", manualStart)
const manualBlock = manual.slice(manualStart, manualEnd)
assert.match(manualBlock, /const learningDb = databaseForDataDomain\(c\.env, 'learning'\)/)
assert.match(manualBlock, /const runStateDb = databaseForDataDomain\(c\.env, 'ops'\)/)
assert.match(manualBlock, /loadStrategyLearningRun\(runStateDb/)
assert.match(manualBlock, /markStrategyLearningRunFinalized\(runStateDb/)
assert.doesNotMatch(manualBlock, /(?:loadStrategyLearningRun|claimStrategyLearningPage|completeStrategyLearningRun|startStrategyLearningLeaseHeartbeat|markStrategyLearningRunFinalized|deferStrategyLearningFinalizer|failStrategyLearningRun|reconcileStrategyLearningFinalizedRetryFastPath|reconcileAndReleaseStrategyLearningFinalizedTelemetry)\(\s*learningDb/, 'manual run state must not use Learning D1')
assert.match(manualBlock, /identityDb: databaseForDataDomain\(c\.env, 'core'\)/)
assert.match(orchestrator, /identityDb: databaseForDataDomain\(env, 'core'\)/)
for (const name of domainRoutedFunctions) {
  assert.doesNotMatch(manualBlock, new RegExp(`${name}\\(c\\.env\\.DB`), `${name} must use the Learning binding`)
}

const learning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const canonicalLabels = fs.readFileSync('src/lib/canonicalSelectionLabels.ts', 'utf8')
const selectionReference = fs.readFileSync('src/lib/selectionReferenceEvidence.ts', 'utf8')
const runState = fs.readFileSync('src/lib/strategyLearningRunState.ts', 'utf8')
const adminWrite = fs.readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')
const resumeStart = adminWrite.indexOf("adminWriteRoutes.post('/api/admin/strategy-learning/resume'")
const resumeEnd = adminWrite.indexOf("adminWriteRoutes.post('/api/admin/strategy/decision-log/materialize'", resumeStart)
const resumeBlock = adminWrite.slice(resumeStart, resumeEnd)
assert.match(resumeBlock, /const opsDb = databaseForDataDomain\(c\.env, 'ops'\)/)
assert.match(resumeBlock, /const run = await opsDb\.prepare/)
assert.match(resumeBlock, /adoptStrategyLearningPostVerifyAuthority\(opsDb/)
assert.doesNotMatch(resumeBlock, /const run = await learningDb\.prepare/)
assert.match(learning, /persistSelectionEvidenceV4\(db,[\s\S]*options\.identityDb \?\? db\)/)
assert.match(learning, /identityDb: options\.identityDb/)
assert.match(learning, /listStrategyLearningCandidates\(options\.candidateDb \?\? db/)
assert.match(runState, /inspectCanonicalStrategyUniverse\([\s\S]*input\.universeDb \?\? db, input\.businessDate, input\.canonicalProducerRunId/)
assert.match(learning, /listStrategyLearningCandidatesAcrossDomains\([\s\S]*funnelDb\.prepare\(`[\s\S]*FROM screener_funnel_items[\s\S]*recommendationDb\.prepare\(`[\s\S]*FROM daily_recommendations/)
assert.match(learning, /hydrateStrategyCandidateDailyFeatures\(marketDb, date, candidates, recommendationDb\)/)
assert.match(learning, /hydrateS12StrategyEvidence\(referenceDb, date, candidates\)/)
assert.match(learning, /reconcileSelectionDecisionEvidenceV4\(db, date, \{[\s\S]*identityDb: options\.identityDb,[\s\S]*canonicalProducerRunId: canonicalRunIds\?\.\[date\]/)
assert.match(selectionReference, /reconcileSelectionDecisionEvidenceV4\([\s\S]*options\.identityDb[\s\S]*canonicalProducerRunId[\s\S]*FROM selection_reference_snapshots_v1[\s\S]*options\.identityDb\.prepare[\s\S]*FROM daily_recommendations/)
assert.match(learning, /FROM json_each\(\?\) h WHERE h\.key=m\.signal_date AND h\.value=m\.producer_run_id/)
assert.match(learning, /refreshStrategyRewardLedger\(db, \{ endDate: date, dryRun: false, canonicalRunIds \}\)/)
assert.match(learning, /refreshStrategyMarginalEdgeV4\(db, date, \{[\s\S]*canonicalRunIds/)
assert.match(learning, /refreshStrategyRouteCalibration\(db, date, \{[\s\S]*canonicalRunIds/)
assert.match(canonicalLabels, /FROM json_each\(\?\) h WHERE h\.key=r\.signal_date AND h\.value=r\.producer_run_id/)
assert.match(canonicalLabels, /listCanonicalReferences\(db, options\.asOfDate, options\.startDate, options\.endDate, options\.canonicalRunIds\)/)
assert.match(manualBlock, /loadCanonicalScreenerRunIds/)
assert.match(orchestrator, /materializeCanonicalSelectionLabelsV4\(learningDb, \{ asOfDate, canonicalRunIds \}\)/)
assert.match(orchestrator, /refreshStrategyRewardLedger\(learningDb, \{ endDate: asOfDate, dryRun: false, canonicalRunIds \}\)/)
assert.match(adminWrite, /canonicalRunIds = await loadCanonicalScreenerRunIds\(c\.env, body\.end_date \?\? twToday\(\)\)/)

assert.doesNotMatch(adminWrite, /(?:seedDefaultStrategySpecRegistry|materializeStrategyDecisionLog|refreshStrategyRewardLedger|refreshStrategyAdaptivePolicyState|refreshStrategyProductionContributionPolicy)\(c\.env\.DB/)
const screener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
assert.doesNotMatch(screener, /listStrategySpecsForLearning\(env\.DB/)

const cronGcp = fs.readFileSync('src/lib/cronGcpDomainTasks.ts', 'utf8')
assert.match(cronGcp, /runS12TwCalibration\(databaseForDataDomain\(env, 'learning'\)/)
assert.doesNotMatch(cronGcp, /runS12TwCalibration\(env\.DB/)
assert.match(manual, /runS12TwCalibration\(databaseForDataDomain\(c\.env, 'learning'\)/)
assert.doesNotMatch(manual, /runS12TwCalibration\(c\.env\.DB/)
const s12Calibration = fs.readFileSync('src/lib/s12TwEquityCalibration.ts', 'utf8')
assert.doesNotMatch(s12Calibration, /JOIN\s+stocks/i)
assert.match(s12Calibration, /NULLIF\(TRIM\(o\.market\), ''\)/)

console.log('strategy learning domain routing contract tests passed')
