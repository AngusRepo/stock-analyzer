export type PipelineBatchProgress = { stage_id:string;phase:'input_prep'|'prepare_prediction_request';completed:number;total:number;observed_at:string }
export function validPipelineBatchProgress(p: any): p is PipelineBatchProgress {
  return Boolean(p && /^[a-f0-9]{64}$/.test(p.stage_id) && ['input_prep','prepare_prediction_request'].includes(p.phase)
    && Number.isSafeInteger(p.total) && p.total>0 && p.total<=10000 && Number.isSafeInteger(p.completed)
    && p.completed>=0 && p.completed<=p.total && typeof p.observed_at==='string'
    && /(Z|[+-]\d{2}:\d{2})$/.test(p.observed_at) && Number.isFinite(Date.parse(p.observed_at)))
}
export async function recordPipelineBatchProgress(db:D1Database, date:string, run:string, p:PipelineBatchProgress) {
  if (!validPipelineBatchProgress(p) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !run) throw new Error('invalid_pipeline_batch_progress')
  return Boolean(await db.prepare(`INSERT INTO pipeline_stage_runs
    (business_date,stage,canonical_run_id,status,cursor_key,updated_at)
    SELECT business_date,?,canonical_run_id,'running',?,? FROM pipeline_stage_runs
     WHERE business_date=? AND stage='pipeline_execution' AND canonical_run_id=? AND status IN ('running','waiting')
    ON CONFLICT(business_date,stage) DO UPDATE SET canonical_run_id=excluded.canonical_run_id,
      cursor_key=excluded.cursor_key,updated_at=excluded.updated_at
    WHERE pipeline_stage_runs.canonical_run_id<>excluded.canonical_run_id
       OR (pipeline_stage_runs.updated_at<excluded.updated_at
         AND json_extract(pipeline_stage_runs.cursor_key,'$.stage_id')=json_extract(excluded.cursor_key,'$.stage_id')
         AND json_extract(pipeline_stage_runs.cursor_key,'$.total')=json_extract(excluded.cursor_key,'$.total')
         AND json_extract(pipeline_stage_runs.cursor_key,'$.completed')<=json_extract(excluded.cursor_key,'$.completed'))
    RETURNING canonical_run_id`).bind('pipeline_batches:'+p.phase,JSON.stringify(p),new Date(p.observed_at).toISOString(),date,run).first())
}
