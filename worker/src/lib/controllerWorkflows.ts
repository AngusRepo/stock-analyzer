export const GCP_DOMAIN_ORCHESTRATION_TASKS = [
  'obsidian-daily',
  'obsidian-sync',
  'regime-compute',
  'model-ic-tracker',
  'verify-v2',
  'weekly-audit',
  'weekly-drift-retrain',
  'weekly-optuna',
  'monthly-optuna',
  'alpha-quality',
  'optuna-queue',
  'lifecycle',
  'backtest',
  'monte-carlo',
  'pbo',
  'retrain',
  'monthly-retrain',
] as const

export {
  runModelIcRollingRefresh,
  runModelIcTrackerChain,
  runObsidianDaily,
  runPaperActivePostmarketPromotion,
  runRegimeCompute,
  runVerifyV2,
} from './controllerDailyWorkflows'

export {
  runOptunaQueueProcessor,
  runWeeklyAudit,
  runWeeklyAlphaQuality,
  runWeeklyBacktest,
  runWeeklyLifecycleCheck,
  runMonthlyOptunaResearch,
  runWeeklyMonteCarlo,
  runWeeklyOptunaResearch,
  runWeeklyPBO,
  runWeeklyDriftRetrain,
  runWeeklyRetrain,
  summarizeWeeklyValidationChain,
  triggerRetrain,
} from './controllerResearchWorkflows'
