/** FinLab's 3 and the pipeline's 6 sub-stage cards (ExecutionChainPanel) for /v1/chain/state. Their progress is
 * not in the P2 state table: it is in OPS_DB pipeline_stage_runs (PK business_date, stage), JSON in cursor_key,
 * read here by primary key. The judgment is the copied finlabStageCards / pipelineStageCards, unchanged; this
 * module only builds the parent job those functions expect. */
import { FINLAB_STAGE_CARDS, finlabStageCards } from './judgment/finlabStageCards'
import { PIPELINE_STAGE_CARDS, pipelineStageCards } from './judgment/pipelineStageCards'
import type { SchedulerJob } from './judgment/schedulerJob'
import { validFinLabStageProgress, validPipelineProgress } from './judgment/stageProgress'
import type { MonitoringEnv } from './env'
import type { BusinessDates } from './tradingDay'

export const FINLAB_PARENT_STAGE = 'finlab-v4-backfill'
export const PIPELINE_PARENT_STAGE = 'pipeline'

/** pipeline_execution is the durable pipeline stage: its canonical_run_id is the run selected for the date. */
export const PROGRESS_STAGES = ['finlab_progress', 'pipeline_execution', 'pipeline_progress', 'pipeline_batches:input_prep',
  'pipeline_batches:prepare_prediction_request'] as const

export const PROGRESS_SQL = `SELECT business_date, stage, canonical_run_id, status, cursor_key, last_error
  FROM pipeline_stage_runs
 WHERE business_date IN (?, ?) AND stage IN (${PROGRESS_STAGES.map((stage) => `'${stage}'`).join(', ')})`

export type ProgressRow = {
  business_date: string
  stage: typeof PROGRESS_STAGES[number]
  canonical_run_id: string
  status: string
  cursor_key: string | null
  last_error: string | null
}

/** business_date → stage → row; at most 5 rows a date. */
export async function readStageProgress(env: MonitoringEnv, dates: BusinessDates): Promise<Map<string, Map<string, ProgressRow>>> {
  const result = await env.OPS_DB.prepare(PROGRESS_SQL).bind(dates.x, dates.xPrev ?? dates.x).all<ProgressRow>()
  const out = new Map<string, Map<string, ProgressRow>>()
  for (const row of result.results ?? []) out.set(row.business_date, (out.get(row.business_date) ?? new Map()).set(row.stage, row))
  return out
}

function parseJson(text: string | null | undefined): unknown {
  try { return JSON.parse(text ?? '') } catch { return null }
}

/** FinLab progress counts only for the run the state row names (run_id) on the row's business date. The state
 * row keeps the summary of its first running write, so a dispatch attempt named there that is newer than the
 * progress proves the progress is a previous attempt's; an older one proves nothing (later attempts do not
 * rewrite a running row) and the progress row itself only ever moves to a newer attempt / sequence. */
function finlabParent(parent: SchedulerJob, row: ProgressRow | undefined): SchedulerJob {
  const progress = parseJson(row?.cursor_key)
  const dispatched = Number(/(?:^|\s)dispatch_attempt=(\d+)/.exec(parent.summary ?? '')?.[1])
  const selected = validFinLabStageProgress(progress) && progress.run_id === parent.runId && progress.run_date === parent.statusRunDate
    && !(dispatched > progress.dispatch_attempt) ? progress : null
  return { ...parent, finlabRunId: parent.runId ?? null, finlabProgress: selected }
}

/** Pipeline progress counts only for the canonical run of the date's pipeline_execution row
 * (pipelineProgressForDisplay in worker/src/lib/pipelineProgress.ts, without the scheduler hand-off log).
 * Sealed = that row is waiting on awaiting_premarket, which only an accepted L3 seal writes
 * (pipelineL3SealAcceptance.ts). P2 does not rewrite a running row's summary, so the seal the card function
 * reads from the parent summary is stated here from the durable row. */
function pipelineParent(parent: SchedulerJob, rows: Map<string, ProgressRow> | undefined): SchedulerJob {
  const execution = rows?.get('pipeline_execution')
  const row = rows?.get('pipeline_progress')
  const progress = parseJson(row?.cursor_key)
  const selected = execution && row?.canonical_run_id === execution.canonical_run_id && validPipelineProgress(progress) ? progress : null
  const batches = PROGRESS_STAGES.filter((stage) => stage.startsWith('pipeline_batches:')).map((stage) => rows?.get(stage))
    .filter((item) => item && item.canonical_run_id === execution?.canonical_run_id).map((item) => parseJson(item!.cursor_key))
    .filter((item): item is NonNullable<SchedulerJob['pipelineBatches']>[number] => typeof (item as { phase?: unknown } | null)?.phase === 'string')
  const sealed = execution?.status === 'waiting' && execution.last_error === 'awaiting_premarket'
  return {
    ...parent, canonicalRunId: execution?.canonical_run_id ?? null,
    pipelineProgress: selected ? { ...selected, run_id: execution!.canonical_run_id, run_date: parent.statusRunDate ?? undefined } : null,
    pipelineBatches: batches,
    ...(sealed ? { summary: `awaiting_premarket l3_sealed=true run_id=${execution.canonical_run_id}` } : {}),
  }
}

export type SubStageCard = {
  parent_stage_id: string
  job: SchedulerJob
  /** The run whose receipts the card shows; null when no progress was accepted. */
  run_id: string | null
  completed_at: string | null
  observed_at: string | null
}

const latest = (stamps: Array<string | null | undefined>) =>
  stamps.filter((stamp): stamp is string => Boolean(stamp)).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null

/** The 9 cards of one business date from its state-row jobs; a date without the parent row has no cards for it. */
export function subStageCards(jobs: Map<string, SchedulerJob>, progress: Map<string, ProgressRow> | undefined, nowMs: number): SubStageCard[] {
  const out: SubStageCard[] = []
  const finlab = jobs.get(FINLAB_PARENT_STAGE)
  if (finlab) {
    const parent = finlabParent(finlab, progress?.get('finlab_progress'))
    const accepted = parent.finlabProgress ?? null
    finlabStageCards(parent, nowMs).forEach((job, index) => {
      const phase = accepted?.phases.find((item) => item.phase === FINLAB_STAGE_CARDS[index].phase)
      out.push({
        parent_stage_id: FINLAB_PARENT_STAGE, job, run_id: accepted?.run_id ?? null, observed_at: accepted?.observed_at ?? null,
        completed_at: job.lastStatus === 'success' || job.lastStatus === 'failed' ? phase?.completed_at ?? null : null,
      })
    })
  }
  const pipeline = jobs.get(PIPELINE_PARENT_STAGE)
  if (pipeline) {
    const parent = pipelineParent(pipeline, progress)
    const accepted = parent.pipelineProgress ?? null
    const receipts = accepted ? Object.values(accepted.executions ?? { legacy: accepted.completed }).flat() : []
    pipelineStageCards(parent, nowMs).forEach((job, index) => {
      const phases = PIPELINE_STAGE_CARDS[index].phases as readonly string[]
      // Ended cards only (completed, or failed themselves): the last receipt of the card's phases.
      const ended = job.stageVisualStatus === 'completed' || job.lastStatus === 'failed'
      out.push({
        parent_stage_id: PIPELINE_PARENT_STAGE, job, run_id: accepted?.run_id ?? null, observed_at: accepted?.observed_at ?? null,
        completed_at: ended ? latest(receipts.filter((item) => phases.includes(item.phase)).map((item) => item.completed_at)) : null,
      })
    })
  }
  return out
}
