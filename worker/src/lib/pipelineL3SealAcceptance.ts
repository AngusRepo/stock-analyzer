/** Accept an authenticated, validated L3 seal for the current canonical run.
 * Release drift alone was previously emitted as a terminal prediction error.
 * Only that exact false failure may be superseded by a genuine L3 receipt.
 */
export async function acceptPipelineL3Seal(db: D1Database, businessDate: string, runId: string): Promise<boolean> {
  const saved = await db.prepare(`UPDATE pipeline_stage_runs
    SET status='waiting',last_error='awaiting_premarket',updated_at=CURRENT_TIMESTAMP
    WHERE business_date=? AND stage='pipeline_execution' AND canonical_run_id=?
      AND (status IN ('running','waiting') OR
        (status='error' AND last_error='pipeline_modal_recovery_source_changed'))
    RETURNING canonical_run_id`).bind(businessDate, runId).first()
  return Boolean(saved)
}
