import type { Bindings, UpdateQueueMsg } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

export const PREMARKET_WAIT = 'active8_oof_lifecycle status=pending reason=awaiting_premarket job_dispatched=false'

/** Durable parking, without consuming queue retries during nights/holidays. */
export async function parkActive8PremarketTicket(env: Bindings, message: UpdateQueueMsg): Promise<void> {
  const db = databaseForDataDomain(env, 'ops')
  const result = await db.prepare(`UPDATE scheduler_execution_tickets_v1
    SET status='triggered', metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.premarket_resume',json(?)),
        last_summary=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE ticket_id=? AND run_id=? AND business_date=? AND task='active8-oof-daily'
      AND status IN ('accepted','queued','running','triggered')`)
    .bind(JSON.stringify(message), PREMARKET_WAIT, message.schedulerTicketId, message.runId,
      String(message.triggerTime).slice(0,10)).run()
  if (Number(result.meta?.changes ?? 0) !== 1) throw new Error('active8_premarket_park_owner_mismatch')
  // Close publication/parking races; otherwise the accepted pipeline callback wakes it.
  await resumeActive8PremarketTickets(env, String(message.triggerTime).slice(0,10))
}

export async function resumeActive8PremarketTickets(env: Bindings, businessDate: string): Promise<number> {
  const db = databaseForDataDomain(env, 'ops')
  const rows = await db.prepare(`SELECT ticket_id,run_id,metadata_json
    FROM scheduler_execution_tickets_v1
    WHERE task='active8-oof-daily' AND business_date=?
      AND status IN ('accepted','queued','triggered')
      AND json_type(metadata_json,'$.premarket_resume')='object'
      AND NOT EXISTS (SELECT 1 FROM scheduler_execution_tickets_v1 root
        WHERE root.ticket_id=scheduler_execution_tickets_v1.root_ticket_id
          AND root.scheduler_job_id='evening-chain' AND root.ticket_kind='physical_root'
          AND root.ticket_id<>(SELECT current.ticket_id FROM scheduler_execution_tickets_v1 current
            WHERE current.scheduler_job_id='evening-chain' AND current.business_date=root.business_date
              AND current.ticket_kind='physical_root' ORDER BY current.updated_at DESC,current.ticket_id DESC LIMIT 1))
      AND EXISTS (SELECT 1 FROM pipeline_stage_runs
        WHERE business_date=? AND stage='pipeline_execution' AND status='success')`)
    .bind(businessDate,businessDate).all<{ticket_id:string;run_id:string;metadata_json:string}>()
  let count = 0
  for (const row of rows.results ?? []) {
    const message = JSON.parse(row.metadata_json).premarket_resume as UpdateQueueMsg
    if (message.schedulerTicketId !== row.ticket_id || message.runId !== row.run_id
      || String(message.triggerTime).slice(0,10) !== businessDate
      || !['active8_oof_after_snapshot','active8_oof_continuation'].includes(message.type)) {
      throw new Error('active8_premarket_resume_identity_mismatch')
    }
    // Marker stays until send succeeds: a callback retry/watchdog recovers an interrupted send.
    const claimed = await db.prepare(`UPDATE scheduler_execution_tickets_v1 SET status='queued',
      last_summary='premarket publication ready; continuation enqueue pending',updated_at=CURRENT_TIMESTAMP
      WHERE ticket_id=? AND run_id=? AND status IN ('accepted','queued','triggered')
        AND json_type(metadata_json,'$.premarket_resume')='object'`)
      .bind(row.ticket_id,row.run_id).run()
    if (Number(claimed.meta?.changes ?? 0) !== 1) continue
    await env.UPDATE_QUEUE.send(message)
    await db.prepare(`UPDATE scheduler_execution_tickets_v1
      SET metadata_json=json_remove(metadata_json,'$.premarket_resume')
      WHERE ticket_id=? AND run_id=?`).bind(row.ticket_id,row.run_id).run()
    count++
  }
  return count
}
