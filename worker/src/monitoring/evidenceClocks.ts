/** /v1/evidence-clocks: the OBS shadow evidence clocks, read by index seeks. The clock judgments are the
 * main Worker's own (shadowAClockFromRows, summarizeRfs, executionParityClockFromRows).
 * Not served (they SCAN today, see the P3 report): RFS cohort totals and matured outcomes. */
import { executionParityClockFromRows, shadowAClockFromRows, type EvidenceClock, type IntentRow } from '../lib/shadowEvidenceClocks'
import { summarizeRfs, type RfsSummary } from '../lib/rfsSparseClock'
import { STRATEGY_ROUTE_CHALLENGER_VERSION } from '../lib/strategyRouteCalibration'
import { addDays, type MonitoringEnv } from './env'

type Row = Record<string, unknown>
const SHADOW_A_COLUMNS = `run_id, artifact_version, candidate_route_version, as_of_date, status, sample_count, date_count,
       train_start_date, train_end_date, oos_start_date, oos_end_date, paired_sample_count, paired_date_count,
       challenger_incumbent_delta, challenger_incumbent_delta_lcb90, gate_json, evidence_artifact_id, created_at`
/** Dates walked back (one as_of_date seek each) to find the latest run of each cohort. */
export const SHADOW_A_DATE_WALK = 10

const byRecency = (a: Row, b: Row) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  || String(b.run_id ?? '').localeCompare(String(a.run_id ?? ''))

/** Latest challenger-version run and latest other-version run, as the original ORDER BY as_of_date DESC,
 * created_at DESC, run_id DESC LIMIT 1 pair, but by date seeks on idx_strategy_route_calibration_runs_v1_date. */
async function shadowAClock(db: D1Database): Promise<EvidenceClock> {
  let date = (await db.prepare('SELECT MAX(as_of_date) AS d FROM strategy_route_calibration_runs_v1').first<Row>())?.d as string | null
  let row: Row | null = null
  let prior: Row | null = null
  for (let step = 0; date && (!row || !prior) && step < SHADOW_A_DATE_WALK; step++) {
    const runs = ((await db.prepare(`SELECT ${SHADOW_A_COLUMNS} FROM strategy_route_calibration_runs_v1 WHERE as_of_date = ?`)
      .bind(date).all<Row>()).results ?? []).sort(byRecency)
    row ??= runs.find((run) => run.candidate_route_version === STRATEGY_ROUTE_CHALLENGER_VERSION) ?? null
    prior ??= runs.find((run) => run.candidate_route_version != null && run.candidate_route_version !== STRATEGY_ROUTE_CHALLENGER_VERSION) ?? null
    date = (await db.prepare('SELECT MAX(as_of_date) AS d FROM strategy_route_calibration_runs_v1 WHERE as_of_date < ?')
      .bind(date).first<Row>())?.d as string | null
  }
  return shadowAClockFromRows(row, prior)
}

async function rfsClock(learning: D1Database, paper: D1Database): Promise<EvidenceClock> {
  const [latest, head] = await Promise.all([
    learning.prepare(`SELECT plan_id, policy_identity, signal_date, status, packet_checksum,
        json_extract(payload_json, '$.model_checksum') AS model_checksum,
        json_extract(payload_json, '$.validation_blockers') AS blockers,
        json_extract(payload_json, '$.source_expected_return_candidate_count') AS candidate_count
       FROM rfs_sparse_comparisons_v1
      WHERE observed_at = (SELECT MAX(observed_at) FROM rfs_sparse_comparisons_v1)
      ORDER BY plan_id DESC LIMIT 1`).first<RfsSummary>(),
    paper.prepare('SELECT plan_id FROM l4_portfolio_head_v1 WHERE account_id = 1').first<{ plan_id: string }>(),
  ])
  const clock = summarizeRfs(latest ?? null, head?.plan_id ?? null, { samples: 0, dates: 0, blocked: 0 }, [])
  return {
    ...clock, sample_count: null, distinct_dates: 0, coverage: null, incumbent_delta: null,
    details: { ...clock.details, blocked_receipts: null, mature_5_session_dates: null, mature_20_session_dates: null, mean_delta_20: null,
      not_served: ['cohort_totals', 'matured_outcomes'], not_served_reason: 'no index on rfs_sparse_comparisons_v1(policy_identity): full scan' },
  }
}

/** No ORDER BY (the parity judgment is order-free; a sort would bill every row twice). */
async function executionParityClock(paper: D1Database, execution: D1Database, nowMs: number): Promise<EvidenceClock> {
  const since = addDays(new Date(nowMs).toISOString().slice(0, 10), -30)
  const [paperResult, realResult] = await Promise.all([
    paper.prepare(`SELECT trade_date, symbol, lower(side) AS side, status FROM paper_order_intents
      WHERE trade_date >= ?`).bind(since).all<IntentRow>(),
    execution.prepare(`SELECT trade_date, symbol, lower(side) AS side, status FROM broker_execution_intents
      WHERE trade_date >= ?`).bind(since).all<IntentRow>(),
  ])
  return executionParityClockFromRows(paperResult.results ?? [], realResult.results ?? [])
}

function unavailable(mechanism: EvidenceClock['mechanism'], label: string, governance: EvidenceClock['governance'], error: unknown): EvidenceClock {
  return {
    mechanism, label, governance, auto_promote: false, status: 'owner_read_unavailable', latest_evidence_date: null,
    sample_count: 0, distinct_dates: 0, supported_regimes: [], coverage: null, incumbent_delta: null, confidence_bound: null,
    blockers: [`owner_read_failed:${error instanceof Error ? error.message : String(error)}`], artifact_or_packet_checksum: null, details: {},
  }
}

export async function evidenceClocksReport(env: MonitoringEnv, nowMs: number) {
  const clocks = await Promise.all([
    shadowAClock(env.LEARNING_DB).catch((error) => unavailable('shadow_a', 'Shadow A route comparison', 'comparison_only', error)),
    rfsClock(env.LEARNING_DB, env.PAPER_DB).catch((error) => unavailable('rfs_allocator', 'RFS allocator comparison', 'comparison_only', error)),
    executionParityClock(env.PAPER_DB, env.EXECUTION_DB, nowMs).catch((error) => unavailable('execution_parity', 'Execution parity', 'manual_only', error)),
  ])
  return {
    schema_version: 'shadow-evidence-clocks-v1', production_effect: false,
    rows: clocks.map(({ details, supported_regimes, blockers, ...clock }) => ({
      ...clock, supported_regimes: supported_regimes.join(','), blockers: blockers.join(','), blocker_count: blockers.length,
    })),
    details: Object.fromEntries(clocks.map((clock) => [clock.mechanism, clock.details])),
  }
}
