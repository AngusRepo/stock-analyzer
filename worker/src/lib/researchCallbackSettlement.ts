import { updateSchedulerExecutionTicket } from './schedulerExecutionTickets'
export const RESEARCH_CALLBACK_TASKS = ['weekly-optuna','monthly-optuna','weekly-audit','model-ic-full-check']
export async function settleResearchCallback(db:D1Database, input:{task:string;date:string;ticketId:string;runId:string;
  status:'success'|'error'|'skipped';summary:string;error?:string}) {
  const ticket=await db.prepare(`SELECT task,business_date,run_id FROM scheduler_execution_tickets_v1 WHERE ticket_id=?`)
    .bind(input.ticketId).first<{task:string;business_date:string;run_id:string}>()
  if (!RESEARCH_CALLBACK_TASKS.includes(input.task) || !ticket || ticket.run_id!==input.runId
    || ticket.task!==input.task || ticket.business_date!==input.date) throw new Error('research_callback_ticket_identity_mismatch')
  return updateSchedulerExecutionTicket(db,{ticketId:input.ticketId,runId:input.runId,status:input.status,
    authority:'scheduler_http',summary:input.summary,error:input.error})
}
