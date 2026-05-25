const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const adminGcp = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')

assert(
  workflows.includes('universalRetrainModalTriggerEnabled') &&
    workflows.includes('UNIVERSAL_RETRAIN_MODAL_TRIGGER_ENABLED') &&
    workflows.includes('RETRAIN_UNIVERSAL_EXECUTOR') &&
    workflows.includes("'/retrain/universal/run'") &&
    workflows.includes('timeoutMs: 60_000') &&
    workflows.includes('triggered via Modal prep') &&
    workflows.includes('function_call_id'),
  'universal retrain must have a short Worker -> controller Modal prep trigger path gated by explicit env flags',
)

assert(
  workflows.includes("'/retrain/universal'") &&
    workflows.includes('timeoutMs: 0') &&
    workflows.includes('callback expected from Modal retrain followup'),
  'universal retrain must keep the existing fire-and-forget Cloud Run service fallback until production is explicitly flipped',
)

assert(
  workflows.includes("candidate_type: 'weekly_drift'") &&
    workflows.includes('train_model_groups: trainModelGroups') &&
    workflows.includes('drift_target_models: targets.map((target) => target.name)') &&
    workflows.includes('drift_target_families: [...new Set(targets.map((target) => target.family))]') &&
    workflows.includes("trigger_source: 'worker_weekly_drift'"),
  'weekly drift retrain Modal trigger must preserve candidate type, target models, target families, and selected training groups',
)

assert(
  workflows.includes("trigger_source: forceMonthly ? 'worker_monthly_retrain' : 'worker_retrain'") &&
    adminGcp.includes("'monthly-retrain'") &&
    adminGcp.includes('triggerRetrain(c.env, true,') &&
    triggerRoutes.includes("'monthly-retrain'") &&
    triggerRoutes.includes('requires sync=1'),
  'monthly/manual retrain surfaces must keep their canonical task ids and long-running trigger contract',
)
