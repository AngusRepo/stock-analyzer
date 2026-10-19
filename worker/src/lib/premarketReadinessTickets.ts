/**
 * Settle only dispatch acknowledgements waiting on this exact daily owner.
 * Stage receipts remain the business authority; this never dispatches work.
 */
export async function settlePremarketReadinessTickets(db: D1Database, date: string): Promise<void> {
  await db.prepare(`UPDATE scheduler_execution_tickets_v1 AS ticket
    SET status='success',status_authority='durable_queue',
        last_summary='status=success premarket_event_chain publication_and_health_complete',
        last_error=NULL,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,
        metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.premarket_completion_run_id',?)
    WHERE task='pre-market-warmup' AND business_date=? AND status='triggered'
      AND instr(last_summary,'status=pending premarket_event_chain ')=1
      AND EXISTS (
        SELECT 1 FROM pipeline_stage_runs AS publication
        JOIN pipeline_stage_runs AS health ON health.business_date=publication.business_date
          AND health.canonical_run_id=publication.canonical_run_id AND health.stage='premarket_v3:market-health'
        JOIN pipeline_stage_runs AS allocation ON allocation.business_date=publication.business_date
          AND allocation.canonical_run_id=publication.canonical_run_id AND allocation.stage='premarket_v3:allocate'
        WHERE publication.business_date=ticket.business_date AND publication.canonical_run_id=?
          AND publication.stage='premarket_v3:publish:0'
          AND publication.status='success' AND health.status='success' AND allocation.status='success'
          AND json_extract(publication.cursor_key,'$.output.ready')=1
          AND json_extract(publication.cursor_key,'$.output.pending_status') IN ('ready','empty','halted')
          AND json_extract(publication.cursor_key,'$.input.l3_receipt.run_id')
            =json_extract(allocation.cursor_key,'$.input.l3_receipt.run_id')
          AND json_extract(publication.cursor_key,'$.input.l3_receipt.checksum')
            =json_extract(allocation.cursor_key,'$.input.l3_receipt.checksum')
          AND length(json_extract(publication.cursor_key,'$.input.l3_receipt.checksum'))=64
          AND json_extract(publication.cursor_key,'$.input.l3_receipt.checksum') NOT GLOB '*[^a-f0-9]*'
          AND json_extract(publication.cursor_key,'$.input.signal_date')
            =json_extract(allocation.cursor_key,'$.input.signal_date')
          AND julianday(allocation.updated_at)<=julianday(publication.updated_at)
          AND julianday(ticket.updated_at)<=MAX(julianday(publication.updated_at),julianday(health.updated_at))
      )`).bind(`${date}:premarket-v3`,date,`${date}:premarket-v3`).run()
}
