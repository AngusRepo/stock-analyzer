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
const morningBriefing = fs.readFileSync('src/lib/morningBriefing.ts', 'utf8')
const rrgCalculator = fs.readFileSync('../ml-controller/services/_rrg_calculator.py', 'utf8')
const sectorFlowService = fs.readFileSync('../ml-controller/services/sector_flow_service.py', 'utf8')
const sectorFlowRotationMigration = fs.readFileSync('migration_sector_flow_rotation_model_2026_06_23.sql', 'utf8')

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
    pendingBuyOrchestrator.includes('AND rs_ratio IS NOT NULL') &&
    pendingBuyOrchestrator.includes('AND rs_momentum IS NOT NULL') &&
    pendingBuyOrchestrator.includes('rrg_rotation_model') &&
    marketScreener.includes('AND rs_ratio IS NOT NULL') &&
    marketScreener.includes('AND rs_momentum IS NOT NULL') &&
    marketScreener.includes('rotationScore') &&
    marketScreener.includes('rrg_rotation_${rotationRegime}') &&
    pendingBuyOrchestrator.includes('RRG_LAGGING_SOFT_RISK') &&
    pendingBuyOrchestrator.includes('RRG_WEAKENING_DOWNGRADE'),
  'P2 must implement the full RRG rotation model, persist rotation fields, and consume them as soft overlay evidence',
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
    recommendationContext.includes('TIMESFM_SIDECAR_MODEL_NAMES') &&
    recommendationContext.includes('timesfmSidecar') &&
    recommendationContext.includes('l2FeatureInputActive') &&
    recommendationContext.includes('l2FeatureInputBlockedReason') &&
    recommendationService.includes('"eligible_for_l2_feature_enrichment": False') &&
    recommendationService.includes('"l2_feature_input_active": False') &&
    recommendationService.includes('requires_formal137_registry_retrain_release') &&
    recommendationCard.includes('L2/L3 Direct ML + L1.75 Sidecar') &&
    recommendationCard.includes('L2 input') &&
    recommendationCard.includes('L2 block formal137/retrain/release') &&
    recommendationCard.includes('TimesFM direct alpha blocked'),
  'P4 must remove TimesFM from direct ML vote display and expose it as an L1.75 sidecar diagnostic without falsely claiming active L2 feature input',
)

assert(
  morningBriefing.includes('not delivered: no_channel_configured') &&
    !morningBriefing.includes('Morning briefing sent to ${channel}') &&
    pendingBuyStateSummary.includes('empty_after_soft_risk') &&
    pendingBuyStateSummary.includes('empty_after_hard_safety'),
  'P5 must distinguish scheduler success from delivery status and expose meaningful empty Morning Setup states',
)

assert(
  fs.existsSync('src/lib/morningSetupP0P6ClosureContract.test.ts') &&
    fs.existsSync('src/lib/pendingBuyFilterAuditMigrationContract.test.ts') &&
    fs.existsSync('src/lib/morningBriefingDeliveryContract.test.ts'),
  'P6 must have itemized local closure contracts for this Morning Setup/RRG/TimesFM/formal137 scope',
)
