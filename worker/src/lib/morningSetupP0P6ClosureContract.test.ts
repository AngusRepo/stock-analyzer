const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const pendingBuyOrchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const pendingBuyStateSummary = fs.readFileSync('src/lib/pendingBuyStateSummary.ts', 'utf8')
const migration = fs.readFileSync('migration_pending_buy_filter_audit_2026_06_23.sql', 'utf8')
const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const formal137 = fs.readFileSync('src/lib/formal137FeatureMaterialization.ts', 'utf8')
const recommendationContext = fs.readFileSync('src/lib/recommendationContext.ts', 'utf8')
const recommendationCard = fs.readFileSync('../frontend/src/components/RecommendationCardClean.tsx', 'utf8')
const recommendationService = fs.readFileSync('../ml-controller/services/recommendation_service.py', 'utf8')
const rrgCalculator = fs.readFileSync('../ml-controller/services/_rrg_calculator.py', 'utf8')
const sectorFlowService = fs.readFileSync('../ml-controller/services/sector_flow_service.py', 'utf8')
const sectorFlowRotationMigration = fs.readFileSync('migration_sector_flow_rotation_model_2026_06_23.sql', 'utf8')
const adminTriggerTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')

assert(
  pendingBuyOrchestrator.includes('withD1Retry') &&
    pendingBuyOrchestrator.includes('preserve_last_valid_state') &&
    !pendingBuyOrchestrator.includes("persistPendingBuys(env, pendingDate, [], { status: 'error'") &&
    adminTriggerTasks.includes('ensurePremarketEventChain(c.env,twToday())') &&
    fs.readFileSync('src/lib/premarketEventWork.ts', 'utf8').includes('deps.recoverPaperMorningSetup(env,date,deps.settle)') &&
    fs.readFileSync('src/lib/paperMorningRecovery.ts', 'utf8').includes('recovered_missing_morning_decision'),
  'Morning Setup transient failures must preserve the last valid state and event stages must recover setup',
)

assert(
    migration.includes('CREATE TABLE IF NOT EXISTS pending_buy_filter_audit') &&
    pendingBuyOrchestrator.includes('persistPendingBuyFilterAudit') &&
    pendingBuyStateSummary.includes('initial_buy_signals') &&
    pendingBuyStateSummary.includes('filterAuditInitialBuySignals'),
  'P1 must persist Morning Setup filter audit and keep initial buy-signal counts visible in empty states',
)

assert(
  rrgCalculator.includes('if rs_momentum is None:') &&
    rrgCalculator.includes('return None') &&
    rrgCalculator.includes('def build_rotation_model') &&
    rrgCalculator.includes('rotation_velocity') &&
    rrgCalculator.includes('rotation_acceleration') &&
    rrgCalculator.includes('quadrant_age') &&
    rrgCalculator.includes('transition_path') &&
    rrgCalculator.includes('rotation_score') &&
    rrgCalculator.includes('rotation_regime') &&
    sectorFlowService.includes('_load_rrg_history') &&
    sectorFlowService.includes('rrg_tail_json') &&
    sectorFlowRotationMigration.includes('ALTER TABLE sector_flow ADD COLUMN rotation_score REAL') &&
    !pendingBuyOrchestrator.includes('rrg_rotation_model') &&
    !pendingBuyOrchestrator.includes('RRG_LAGGING_SOFT_RISK') &&
    !pendingBuyOrchestrator.includes('RRG_WEAKENING_DOWNGRADE') &&
    !marketScreener.includes("stage: 'rrg_overlay'") &&
    marketScreener.includes("stage: 'pit_residual_momentum_shadow'"),
  'P2 legacy RRG history must remain readable while current screener and pending-buy authority stay retired',
)

assert(
  formal137.includes('formal137MarginBalanceRank') &&
    formal137.includes('finlabCsMarginBalanceRank') &&
    formal137.includes('formal137UsSentimentScoreRank') &&
    marketScreener.includes('materializeFormal137FeatureAliases(candidates)') &&
    marketScreener.includes('materializeFormal137UsSentimentScoreRank(candidates)'),
  'P3 must materialize 0081/0193 formal137 aliases from existing raw/normalized evidence without inventing values',
)

assert(
  recommendationContext.includes('DIRECT_ALPHA_VOTE_MODEL_NAMES') &&
    !recommendationContext.includes('timesfmSidecar') &&
    !recommendationService.includes('"timesfm_sidecar": _timesfm_sidecar_payload(data)') &&
    !recommendationCard.includes('L2 TimesFM + L3 Direct ML') &&
    !recommendationCard.includes('L2 block formal137/retrain/release'),
  'R32 retires TimesFM generation, prediction publication and active sidecar display',
)

assert(
  pendingBuyStateSummary.includes('empty_after_soft_risk') &&
    pendingBuyStateSummary.includes('empty_after_hard_safety'),
  'P5 must expose meaningful empty Morning Setup states',
)

assert(
  fs.existsSync('src/lib/morningSetupP0P6ClosureContract.test.ts') &&
    fs.existsSync('src/lib/pendingBuyFilterAuditMigrationContract.test.ts'),
  'P6 must have itemized local closure contracts for this Morning Setup/RRG/TimesFM/formal137 scope',
)
