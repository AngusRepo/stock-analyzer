import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const schedulerRunLogger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')

assert(
  adminControlRoutes.includes("adminControlRoutes.post('/api/admin/cron-callback'") &&
    adminControlRoutes.includes("adminControlRoutes.post('/api/admin/scheduler-callback'"),
  'cron and scheduler callbacks must share the callback handler',
)

assert(
  adminControlRoutes.includes('const callbackRunDate') &&
    adminControlRoutes.includes("typeof body.run_date === 'string'") &&
    adminControlRoutes.includes("typeof body.date === 'string'"),
  'callback handler must resolve explicit run_date/date before logging',
)

assert(
  adminControlRoutes.includes('const callbackRunId') &&
    adminControlRoutes.includes('run_id: callbackRunId') &&
    adminControlRoutes.includes('run_date: callbackRunDate'),
  'callback handler must persist run_id and run_date to scheduler logs',
)

assert(
  schedulerRunLogger.includes('run_id?: string') &&
    schedulerRunLogger.includes('run_date?: string') &&
    schedulerRunLogger.includes('run_id: result.run_id') &&
    schedulerRunLogger.includes('run_date: today'),
  'canonical scheduler logger must store run_id/run_date payload fields',
)
