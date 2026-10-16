/** Accept an authenticated, validated L3 seal for the current canonical run.
 * Release drift and an earlier unfinished input attempt can be false failures
 * after recovery. Only these exact errors yield to a genuine same-run L3 seal.
 */
export async function acceptPipelineL3Seal(db: D1Database, businessDate: string, runId: string): Promise<boolean> {
  const saved = await db.prepare(`UPDATE pipeline_stage_runs
    SET status='waiting',last_error='awaiting_premarket',updated_at=CURRENT_TIMESTAMP
    WHERE business_date=? AND stage='pipeline_execution' AND canonical_run_id=?
      AND (status IN ('running','waiting') OR
        (status='error' AND last_error IN ('pipeline_modal_recovery_source_changed',
          'pipeline_input_continuation_unfinished:failed',
          'pipeline_input_continuation_unfinished:succeeded')))
    RETURNING canonical_run_id`).bind(businessDate, runId).first()
  return Boolean(saved)
}

/** Reconcile the physical root only after the current authenticated L3 handoff.
 * The root remains nonterminal until L4 and its downstream DAG complete.
 */
export async function acceptEveningRootL3Wait(
  db: D1Database, businessDate: string, runId: string, checksum: string,
): Promise<boolean> {
  const saved = await db.prepare(`UPDATE scheduler_execution_tickets_v1
    SET status='triggered',status_authority='durable_pipeline_stage',
      metadata_json=json_set(metadata_json,
        '$.l3_previous_error',COALESCE(last_error,json_extract(metadata_json,'$.l3_previous_error')),
        '$.l3_previous_summary',CASE WHEN status='error' THEN last_summary
          ELSE json_extract(metadata_json,'$.l3_previous_summary') END,
        '$.l3_run_id',?,'$.l3_checksum',?),
      last_summary=?,last_error=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE ticket_id=(SELECT ticket_id FROM scheduler_execution_tickets_v1
      WHERE scheduler_job_id='evening-chain' AND business_date=? AND ticket_kind='physical_root'
      ORDER BY updated_at DESC,ticket_id DESC LIMIT 1)
      AND (status IN ('accepted','queued','running','triggered') OR
        (status='error' AND last_error LIKE 'pipeline_execution:error%'
          AND NOT EXISTS (SELECT 1 FROM json_each('[' || replace(json_quote(last_error),',','","') || ']')
            WHERE value<>'pipeline_execution:error' AND value NOT LIKE '%:missing')))
      AND EXISTS (SELECT 1 FROM pipeline_stage_runs WHERE business_date=?
        AND stage='pipeline_execution' AND canonical_run_id=?
        AND status='waiting' AND last_error='awaiting_premarket')
      AND (SELECT COUNT(*) FROM pipeline_stage_runs WHERE business_date=?
        AND stage IN ('finlab_market','finlab_sequence','screener_v2','post_screener_continuation')
        AND status='success')=4
      AND NOT EXISTS (SELECT 1 FROM pipeline_stage_runs WHERE business_date=?
        AND canonical_run_id=? AND stage IN ('post_pipeline_chain','verify_v2','post_verify_chain')
        AND status IN ('error','blocked','skipped'))
    RETURNING ticket_id`).bind(runId,checksum,
      `awaiting_premarket l3_sealed=true cloud_compute_stopped=true run_id=${runId}`,
      businessDate,businessDate,runId,businessDate,businessDate,runId).first()
  return Boolean(saved)
}
