import assert from 'node:assert/strict'
import fs from 'node:fs'

const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const queueStart = orchestrator.indexOf("if (msg.type === 'strategy_learning_materialize')")
const queueEnd = orchestrator.indexOf("if (msg.type === 'source_readiness_retry')", queueStart)
const queueBlock = orchestrator.slice(queueStart, queueEnd)
assert.match(queueBlock, /const learningDb = databaseForDataDomain\(env, 'learning'\)/)
assert.match(queueBlock, /const opsDb = databaseForDataDomain\(env, 'ops'\)/)
assert.match(queueBlock, /initializeStrategyLearningRun\(learningDb,[\s\S]*universeDb: opsDb/)
assert.match(queueBlock, /materializeStrategyDecisionLogChunk\(learningDb,[\s\S]*candidateDb: opsDb/)

const learningOwnerFunctions = [
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
for (const name of learningOwnerFunctions) {
  assert.doesNotMatch(queueBlock, new RegExp(`${name}\\(env\\.DB`), `${name} must use the Learning binding`)
}

const manual = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const manualStart = manual.indexOf("'strategy-learning-finalize': async () =>")
const manualEnd = manual.indexOf("'selection-reference-identity-repair': async () =>", manualStart)
const manualBlock = manual.slice(manualStart, manualEnd)
assert.match(manualBlock, /const learningDb = databaseForDataDomain\(c\.env, 'learning'\)/)
for (const name of learningOwnerFunctions) {
  assert.doesNotMatch(manualBlock, new RegExp(`${name}\\(c\\.env\\.DB`), `${name} must use the Learning binding`)
}

const learning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const runState = fs.readFileSync('src/lib/strategyLearningRunState.ts', 'utf8')
assert.match(learning, /listStrategyLearningCandidates\(options\.candidateDb \?\? db/)
assert.match(runState, /inspectCanonicalStrategyUniverse\(input\.universeDb \?\? db/)

const adminWrite = fs.readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')
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
