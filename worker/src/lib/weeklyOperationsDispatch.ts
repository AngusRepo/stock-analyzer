import type { Bindings } from '../types'
import { controllerJson } from './controllerClient'
import { twToday } from './dateUtils'

export async function dispatchWeeklyOperation(env: Bindings, task: 'weekly-audit' | 'model-ic-full-check',
  runDate = twToday(), context: {schedulerTicketId?: string; schedulerRunId?: string} = {}): Promise<string> {
  const runId = context.schedulerRunId || `${task}:${runDate}`
  const result = await controllerJson<any>(env, '/audit/weekly_operations/run', {
    method: 'POST', timeoutMs: 60_000,
    jsonBody: {task, run_date:runDate, run_id:runId,
      scheduler_ticket_id:context.schedulerTicketId, scheduler_run_id:context.schedulerRunId},
  })
  if (result.status !== 'triggered' || !result.execution_id) throw new Error('weekly_operation_dispatch_receipt_missing')
  return `triggered run_id=${runId} execution_id=${result.execution_id} callback expected`
}
