import assert from 'node:assert/strict'
import fs from 'node:fs'

const logger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/cronOrchestrator.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')

assert(
  logger.includes('recordSchedulerRunReportArtifact') &&
    logger.includes('scheduler_report_artifact_failed'),
  'scheduler run logger must write a durable scheduler report artifact in addition to KV',
)
assert(
  logger.includes('getSchedulerRunReportArtifactLogs') &&
    logger.includes('FROM dataset_snapshots') &&
    logger.includes('env.ARTIFACTS'),
  'scheduler log readback must fall back to durable report artifacts when KV logs are missing',
)

assert(
  orchestrator.includes('logCronResult(env.KV, task,') &&
    orchestrator.includes('env as any'),
  'cron orchestrator must pass env to scheduler logger so durable report artifacts can be written',
)

assert(
  triggerRoutes.includes('logSchedulerResult(c.env.KV, task,') &&
    triggerRoutes.includes('c.env as any'),
  'manual/admin trigger route must pass env to scheduler logger for durable report artifacts',
)
