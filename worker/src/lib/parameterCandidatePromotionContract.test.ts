import assert from 'node:assert/strict'
import fs from 'node:fs'

const registry = fs.readFileSync('src/lib/parameterCandidateRegistry.ts', 'utf8')
const optunaRoutes = fs.readFileSync('src/routes/adminOptunaRoutes.ts', 'utf8')
const controlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const lifecycleRoutes = fs.readFileSync('src/routes/adminConfigLifecycleRoutes.ts', 'utf8')
const workflowRoutes = fs.readFileSync('src/routes/adminConfigWorkflowRoutes.ts', 'utf8')
const coreRoutes = fs.readFileSync('src/routes/adminConfigCoreRoutes.ts', 'utf8')
const controllerWorkflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const schema = fs.readFileSync('schema.sql', 'utf8')
const optunaJob = fs.readFileSync('../ml-controller/optuna_job_main.py', 'utf8')
const configPool = fs.readFileSync('../ml-controller/routers/config_pool.py', 'utf8')
const kvPusher = fs.readFileSync('../ml-controller/services/kv_pusher.py', 'utf8')
const schedulerStatus = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')

assert(
  registry.includes('CREATE TABLE IF NOT EXISTS parameter_candidate_registry') &&
    registry.includes('CREATE TABLE IF NOT EXISTS parameter_candidate_evidence') &&
    registry.includes('recordParameterCandidateFromSandbox'),
  'parameter candidates must persist in D1 registry/evidence tables, not only 30d KV sandbox',
)

assert(
  schema.includes('CREATE TABLE IF NOT EXISTS parameter_candidate_registry') &&
    schema.includes('CREATE TABLE IF NOT EXISTS parameter_candidate_evidence') &&
    schema.includes('CREATE TABLE IF NOT EXISTS parameter_candidate_events'),
  'canonical D1 schema.sql must include parameter candidate registry/evidence/event tables to avoid lazy-schema split-brain',
)

assert(
  registry.includes('candidateRowByPromotionPacket') &&
    registry.includes('promotion_packet_not_found') &&
    registry.includes("packetDecision === 'PASS'"),
  'promotion validation must be packet-addressable and evidence PASS must require a validation_packet PASS',
)

assert(
  optunaRoutes.includes('recordParameterCandidateFromSandbox') &&
    optunaRoutes.includes('recordGaParameterCandidate') &&
    optunaRoutes.includes('candidate_id'),
  'optuna-push must return and persist structured parameter candidate ids for sandbox and GA shadow state',
)

assert(
  optunaJob.includes('"candidate_ids"') &&
    optunaJob.includes('"push_results"') &&
    optunaJob.includes('"cadence"') &&
    optunaJob.includes('"snapshot"'),
  'weekly/monthly Optuna Job callback must include structured candidate_ids/push_results/cadence/snapshot metadata',
)

assert(
  controlRoutes.includes("String(body.task) === 'weekly-optuna'") &&
    controlRoutes.includes("String(body.task) === 'monthly-optuna'") &&
    controlRoutes.includes('runParameterCandidateValidationChain'),
  'weekly/monthly Optuna success callback must trigger parameter candidate validation chain automatically',
)

assert(
  controllerWorkflows.includes('/config_pool/parameter_candidates/validation_chain') &&
    controllerWorkflows.includes('runParameterCandidateValidationChain') &&
    controllerWorkflows.includes('ensureParameterCandidateTables'),
  'Worker must expose a controller workflow for candidate-specific validation chain',
)

assert(
  controllerWorkflows.includes('/config_pool/parameter_candidates/validation_chain/run') &&
    controlRoutes.includes('classifySchedulerSummary(summary)') &&
    optunaJob.includes('job_kind == "parameter_validation"') &&
    configPool.includes('/parameter_candidates/validation_chain/run'),
  'weekly/monthly Optuna callback must trigger async parameter validation Job and let the Job callback own final scheduler status',
)

assert(
  configPool.includes('/parameter_candidates/validation_chain') &&
    configPool.includes('candidate-specific') &&
    configPool.includes('promotion_packet_id') &&
    configPool.includes('ON CONFLICT(candidate_id) DO NOTHING') &&
    configPool.includes('/api/admin/config/parameter-candidates?limit=1'),
  'ml-controller must expose candidate-specific validation chain and persist promotion packet ids',
)

assert(
  configPool.includes('DELETE FROM parameter_candidate_evidence') &&
    configPool.includes('validation_run_id') &&
    configPool.includes('candidate_validation_running'),
  'parameter candidate validation must be idempotent per candidate/run and expose per-candidate running events',
)

assert(
  kvPusher.includes('OPTUNA_RUN_ID') &&
    kvPusher.includes('OPTUNA_CADENCE') &&
    kvPusher.includes('OPTUNA_RUN_DATE'),
  'Optuna push metadata must carry run_id/cadence/run_date so registry rows are traceable to the scheduler execution',
)

assert(
  schedulerStatus.includes("id: 'parameter-candidate-validation'") &&
    schedulerStatus.includes('status: lastStatus') &&
    schedulerStatus.includes('run_id: lastLog?.run_id ?? null') &&
    schedulerStatus.includes('run_date: lastLog?.run_date ?? null') &&
    schedulerStatus.includes('timestamp: lastLog?.timestamp ?? null'),
  'scheduler status readback must expose parameter validation and callback run identifiers for dashboard closure',
)

assert(
  lifecycleRoutes.includes('parameter_candidate_requires_evidence_packet') &&
    lifecycleRoutes.includes('validateParameterCandidateEvidencePacket') &&
    !lifecycleRoutes.includes("entry.source === 'alpha_framework'"),
  'challenger gate must require candidate_id + PASS evidence for all parameter sources, not only alpha_framework',
)

assert(
  (lifecycleRoutes.includes('X-Confirm-Production-Override') || lifecycleRoutes.includes('PRODUCTION_OVERRIDE_HEADER')) &&
    (workflowRoutes.includes('X-Confirm-Production-Override') || workflowRoutes.includes('PRODUCTION_OVERRIDE_HEADER')) &&
    (coreRoutes.includes('X-Confirm-Production-Override') || coreRoutes.includes('PRODUCTION_OVERRIDE_HEADER')) &&
    lifecycleRoutes.includes('promotion_packet_id') &&
    workflowRoutes.includes('promotion_packet_id') &&
    coreRoutes.includes('promotion_packet_id'),
  'prod config writes/promotes must require promotion_packet_id or explicit audited production override',
)

assert(
  configPool.includes('shadow_stability_only') &&
    !configPool.includes('/api/admin/config/challenger/promote_to_prod') &&
    !lifecycleRoutes.includes('auto-promote from weekly_eval'),
  'weekly_eval must be shadow stability only and must not directly auto-promote production',
)

assert(
  configPool.includes('cscv_rank_logit') &&
    configPool.includes('proxy_pbo_blocked'),
  'proxy PBO must stay blocked and cannot be displayed/used as promotion-grade PASS',
)

console.log('parameter candidate promotion closure contract ok')
