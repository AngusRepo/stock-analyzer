const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const trigger = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const taskMap = fs.readFileSync('src/lib/adminTriggerTaskMap.ts', 'utf8')
const adminGcp = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const index = fs.readFileSync('src/index.ts', 'utf8')
const control = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const router = fs.readFileSync('../ml-controller/routers/optuna.py', 'utf8')
const job = fs.readFileSync('../ml-controller/optuna_job_main.py', 'utf8')

assert(
  trigger.includes('schedulerContext.schedulerTicketId = schedulerTicketId')
    && trigger.includes('schedulerContext.schedulerRunId = executionRunId'),
  'admitted durable ticket identity must be bound before the Optuna trigger executes',
)
assert(
  taskMap.includes('SchedulerCallbackContext')
    && adminGcp.includes('deps.runWeeklyOptunaResearch(requestedRunDate(), schedulerContext)')
    && index.includes('runWeeklyOptunaResearchWorkflow(c.env, runDate, context)'),
  'Worker trigger wiring must carry scheduler context into weekly Optuna',
)
assert(
  workflows.includes('scheduler_ticket_id: options.schedulerTicketId')
    && workflows.includes('scheduler_run_id: options.schedulerRunId'),
  'Worker controller request must carry both immutable ticket identifiers',
)
assert(
  router.includes('OPTUNA_SCHEDULER_TICKET_ID')
    && router.includes('OPTUNA_SCHEDULER_RUN_ID')
    && job.includes('payload["scheduler_ticket_id"]')
    && job.includes('payload["scheduler_run_id"]'),
  'controller and Cloud Run Job must preserve ticket identity into the callback payload',
)
assert(
  control.includes('optuna_callback_missing_scheduler_ticket_identity')
    && control.includes('updateSchedulerExecutionTicket')
    && control.includes('optuna_scheduler_ticket_settlement_failed'),
  'weekly/monthly Optuna callback must fail closed and durably settle its exact ticket',
)
