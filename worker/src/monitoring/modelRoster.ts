/** /v1/models/roster: the published alpha roster (R33 core4 since 11/24, p4 F1), each model's offline gate result
 * and thresholds, the latest monthly training run, and the next monthly run from the Scheduler manifest
 * (p4_sources.md §2A). The roster check is the main Worker's publishedAlphaModelOrderProjected; the roster is never
 * read from model_champion_pointers or ACTIVE_ALPHA_MODELS, which still list retired models (p4 F2).
 * Models excluded from training (R33_EXCLUDED_MODELS) have no registry rows: only what was trained is shown. */
import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'
import { publishedAlphaModelOrderProjected } from '../lib/alphaModelRoster'
import { addDays, TW_OFFSET_MS, type MonitoringEnv } from './env'

export const MONTHLY_JOB_ID = 'active8-oof-monthly'
/** Two monthly cycles: the latest run is still found after one skipped (or paused) month. */
export const REGISTRY_WINDOW_DAYS = 62
/** model_artifact_registry.state CHECK list: every state must be named, or updated_at falls off the index seek. */
export const REGISTRY_STATES = ['registered', 'registration_failed', 'offline_failed', 'offline_passed_weak', 'offline_passed',
  'offline_strong_pass', 'candidate_selected', 'shadowing', 'live_gate_passed', 'approval_required', 'approved', 'production',
  'rejected', 'archived'] as const

const POINTER_SQL = `SELECT p.artifact_id, p.cohort_id, p.promoted_at, p.promotion_reason, a.state, a.knowledge_cutoff_date,
       a.training_run_id, a.validation_decision, a.created_at, a.payload_json -> '$.validation' AS validation_json
  FROM active8_ensemble_pointer_v1 p JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id = p.artifact_id
 WHERE p.singleton_id = 1`
const RUNS_SQL = `SELECT training_run_id, source_run_date, updated_at FROM model_artifact_registry
 WHERE candidate_type = 'oof_full_fit_release' AND state IN (${REGISTRY_STATES.map(() => '?').join(', ')}) AND updated_at >= ?`
// One row per model per run (idx_model_artifact_registry_run); json_extract keeps the 73-514 KB evidence in D1.
// candidate_type is filtered in JS: in the WHERE clause the planner may take the candidate_type index instead.
const GATE_COLUMNS = `artifact_id, model_name, version, state, source_run_date, training_run_id, offline_gate_decision,
       offline_gate_failed_gates, live_gate_status, promotion_decision, updated_at,
       json_extract(offline_evidence_json, '$.gate.metrics.oos_ic') AS oos_ic,
       json_extract(offline_evidence_json, '$.gate.metrics.min_oos_ic_mean') AS min_oos_ic_mean,
       json_extract(offline_evidence_json, '$.gate.metrics.weak_oos_ic_mean') AS weak_oos_ic_mean,
       json_extract(offline_evidence_json, '$.gate.metrics.strong_oos_ic_mean') AS strong_oos_ic_mean,
       json_extract(offline_evidence_json, '$.gate.policy.pbo.max_pbo') AS max_pbo`

type Pointer = { artifact_id: string; cohort_id: string; promoted_at: string; promotion_reason: string; state: string
  knowledge_cutoff_date: string; training_run_id: string; validation_decision: string; created_at: string; validation_json: string | null }
type GateRow = { artifact_id: string; model_name: string; version: string; state: string; source_run_date: string | null
  training_run_id: string; offline_gate_decision: string; offline_gate_failed_gates: string; live_gate_status: string
  promotion_decision: string; updated_at: string; oos_ic: number | null; min_oos_ic_mean: number | null
  weak_oos_ic_mean: number | null; strong_oos_ic_mean: number | null; max_pbo: number | null }
type RunRow = { training_run_id: string | null; source_run_date: string | null; updated_at: string }

function parseJson(text: string | null): unknown {
  if (text == null) return null
  try { return JSON.parse(text) } catch { return text }
}

/** Same columns with or without a registry row, so Grafana tables keep their fields. */
const gate = (row: GateRow | undefined) => ({
  version: row?.version ?? null, state: row?.state ?? null, source_run_date: row?.source_run_date ?? null,
  gate_decision: row?.offline_gate_decision ?? null, failed_gates: row ? parseJson(row.offline_gate_failed_gates) : null,
  oos_ic: row?.oos_ic ?? null, min_oos_ic_mean: row?.min_oos_ic_mean ?? null, weak_oos_ic_mean: row?.weak_oos_ic_mean ?? null,
  strong_oos_ic_mean: row?.strong_oos_ic_mean ?? null, max_pbo: row?.max_pbo ?? null,
  live_gate_status: row?.live_gate_status ?? null, promotion_decision: row?.promotion_decision ?? null,
})

const DOWS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Next run of a "first <weekday> of month HH:MM" job after nowMs, in the job's Asia/Taipei time. Same phrase as
 * schedulerPolicy.parseFirstWeekdayOfMonth, which is not exported. */
export function nextFirstWeekdayRun(schedule: string, timeZone: string | undefined, nowMs: number): string | null {
  const match = /^first\s+([a-z]{3})[a-z]*\s+of\s+month\s+(\d{1,2}):(\d{2})$/i.exec(schedule.trim())
  const dow = match ? DOWS.indexOf(match[1].toLowerCase()) : -1
  if (!match || dow < 0) return null
  const offsetMs = timeZone === 'Asia/Taipei' ? TW_OFFSET_MS : 0
  const local = new Date(nowMs + offsetMs)
  for (let month = 0; month < 3; month++) {
    const first = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + month, 1, Number(match[2]), Number(match[3])))
    first.setUTCDate(1 + (dow - first.getUTCDay() + 7) % 7)
    if (first.getTime() - offsetMs > nowMs) return `${first.toISOString().slice(0, 16)}${offsetMs ? '+08:00' : 'Z'}`
  }
  return null
}

export async function modelRosterReport(env: MonitoringEnv, nowMs: number) {
  const db = env.LEARNING_DB
  const since = addDays(new Date(nowMs).toISOString().slice(0, 10), -REGISTRY_WINDOW_DAYS)
  const [order, pointer, runs] = await Promise.all([
    publishedAlphaModelOrderProjected(db).then((models) => ({ models, error: null as string | null }),
      (error: unknown) => ({ models: [] as string[], error: error instanceof Error ? error.message : String(error) })),
    db.prepare(POINTER_SQL).first<Pointer>(),
    db.prepare(RUNS_SQL).bind(...REGISTRY_STATES, since).all<RunRow>(),
  ])
  // No pointer row: publishedAlphaModelOrderProjected falls back to the legacy eight; say so instead of showing them as live.
  const rosterStatus = order.error ? 'invalid' : pointer ? 'published' : 'no_pointer_legacy_default'
  const latestRun = (runs.results ?? []).filter((row) => row.training_run_id)
    .sort((a, b) => String(b.source_run_date ?? '').localeCompare(String(a.source_run_date ?? '')) || b.updated_at.localeCompare(a.updated_at))[0] ?? null
  const runIds = [...new Set([pointer?.training_run_id, latestRun?.training_run_id].filter((id): id is string => Boolean(id)))]
  const [champions, gates] = await Promise.all([
    order.models.length
      ? db.prepare(`SELECT model_name, champion_version, champion_artifact_id, promoted_at, promotion_reason
          FROM model_champion_pointers WHERE model_name IN (${order.models.map(() => '?').join(', ')})`).bind(...order.models)
        .all<{ model_name: string; champion_version: string; champion_artifact_id: string | null; promoted_at: string; promotion_reason: string | null }>()
      : null,
    runIds.length
      ? db.prepare(`SELECT candidate_type, ${GATE_COLUMNS} FROM model_artifact_registry
          WHERE training_run_id IN (${runIds.map(() => '?').join(', ')})`).bind(...runIds).all<GateRow & { candidate_type: string }>()
      : null,
  ])
  const gateRows = (gates?.results ?? []).filter((row) => row.candidate_type === 'oof_full_fit_release')
  const championByModel = new Map((champions?.results ?? []).map((row) => [row.model_name, row]))
  const rows = order.models.map((model, slot) => {
    const champion = championByModel.get(model)
    const live = gateRows.find((row) => row.artifact_id === champion?.champion_artifact_id)
      ?? gateRows.find((row) => row.model_name === model && row.training_run_id === pointer?.training_run_id)
    return {
      model_name: model, slot, champion_version: champion?.champion_version ?? null, champion_artifact_id: champion?.champion_artifact_id ?? null,
      champion_promoted_at: champion?.promoted_at ?? null, champion_promotion_reason: champion?.promotion_reason ?? null,
      gate_training_run_id: live?.training_run_id ?? null, ...gate(live),
    }
  })
  const job = (schedulerManifest as { jobs: Array<{ id: string; schedule: string; timeZone?: string; desiredState?: string }> }).jobs
    .find((item) => item.id === MONTHLY_JOB_ID)
  return {
    roster_status: rosterStatus, roster_error: order.error, model_count: order.models.length,
    ensemble: pointer ? {
      artifact_id: pointer.artifact_id, cohort_id: pointer.cohort_id, state: pointer.state, promoted_at: pointer.promoted_at,
      promotion_reason: pointer.promotion_reason, knowledge_cutoff_date: pointer.knowledge_cutoff_date,
      training_run_id: pointer.training_run_id, validation_decision: pointer.validation_decision, validation: parseJson(pointer.validation_json),
    } : null,
    rows,
    latest_monthly_run: latestRun ? {
      training_run_id: latestRun.training_run_id, source_run_date: latestRun.source_run_date,
      is_live: latestRun.training_run_id === pointer?.training_run_id,
      models: gateRows.filter((row) => row.training_run_id === latestRun.training_run_id)
        .sort((a, b) => a.model_name.localeCompare(b.model_name)).map((row) => ({ model_name: row.model_name, artifact_id: row.artifact_id, ...gate(row) })),
    } : null,
    // The repo manifest's schedule and desiredState; the live Cloud Scheduler state (ENABLED/PAUSED) is not visible here.
    next_monthly_run: job ? {
      job_id: job.id, schedule: job.schedule, time_zone: job.timeZone ?? null, repo_desired_state: job.desiredState ?? 'ENABLED',
      next_run_at: job.desiredState === 'PAUSED' ? null : nextFirstWeekdayRun(job.schedule, job.timeZone, nowMs),
    } : null,
  }
}
