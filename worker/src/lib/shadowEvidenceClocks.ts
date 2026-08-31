import { databaseForDataDomain } from './dataDomainRegistry'
import type { Bindings } from '../types'
import {
  STRATEGY_ROUTE_CHALLENGER_VERSION,
  STRATEGY_ROUTE_MIN_OOS_DATES,
  STRATEGY_ROUTE_MIN_TOTAL_DATES,
  STRATEGY_ROUTE_MIN_TRAIN_DATES,
} from './strategyRouteCalibration'

export type EvidenceClockMechanism = 'shadow_a' | 'rfs_allocator' | 'execution_parity'

export type EvidenceClock = {
  mechanism: EvidenceClockMechanism
  label: string
  governance: 'comparison_only' | 'manual_only'
  auto_promote: false
  status: string
  latest_evidence_date: string | null
  sample_count: number
  distinct_dates: number
  supported_regimes: string[]
  coverage: number | null
  incumbent_delta: number | null
  confidence_bound: number | null
  blockers: string[]
  artifact_or_packet_checksum: string | null
  details: Record<string, unknown>
}

export type EvidenceClockReport = {
  success: true
  mode: 'read_only'
  schema_version: 'shadow-evidence-clocks-v1'
  generated_at: string
  clocks_are_independent: true
  production_effect: false
  clocks: EvidenceClock[]
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(value ?? '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))] : []
}

function unavailable(
  mechanism: EvidenceClockMechanism,
  label: string,
  governance: EvidenceClock['governance'],
  error: unknown,
): EvidenceClock {
  return {
    mechanism,
    label,
    governance,
    auto_promote: false,
    status: 'owner_read_unavailable',
    latest_evidence_date: null,
    sample_count: 0,
    distinct_dates: 0,
    supported_regimes: [],
    coverage: null,
    incumbent_delta: null,
    confidence_bound: null,
    blockers: [`owner_read_failed:${error instanceof Error ? error.message : String(error)}`],
    artifact_or_packet_checksum: null,
    details: {},
  }
}

async function shadowAClock(env: Bindings): Promise<EvidenceClock> {
  const db = databaseForDataDomain(env, 'learning')
  const row = await db.prepare(`
    SELECT run_id, artifact_version, candidate_route_version, as_of_date, status,
           sample_count, date_count, train_start_date, train_end_date,
           oos_start_date, oos_end_date,
           paired_sample_count, paired_date_count, challenger_incumbent_delta,
           challenger_incumbent_delta_lcb90, gate_json, evidence_artifact_id
      FROM strategy_route_calibration_runs_v1
     WHERE candidate_route_version=?
     ORDER BY as_of_date DESC, created_at DESC, run_id DESC
     LIMIT 1
  `).bind(STRATEGY_ROUTE_CHALLENGER_VERSION).first<Record<string, unknown>>()
  const priorRow = await db.prepare(
    'SELECT run_id, artifact_version, candidate_route_version, as_of_date, status, ' +
    'sample_count, date_count, paired_sample_count, paired_date_count ' +
    'FROM strategy_route_calibration_runs_v1 WHERE candidate_route_version<>? ' +
    'ORDER BY as_of_date DESC, created_at DESC, run_id DESC LIMIT 1',
  ).bind(STRATEGY_ROUTE_CHALLENGER_VERSION).first<Record<string, unknown>>()
  const gate = jsonRecord(row?.gate_json)
  const gateMetadata = jsonRecord(gate._metadata)
  const blockers = stringList(gate.failed_gates ?? gate.blockers)
  if (row && ['fail', 'blocked'].includes(String(row.status ?? '').toLowerCase()) && !blockers.length) {
    blockers.push('route_gate_failed_without_structured_blocker')
  }
  const sampleCount = Number(row?.paired_sample_count ?? row?.sample_count ?? 0)
  const total = Number(row?.sample_count ?? 0)
  if (row && String(row.status ?? '').toLowerCase() === 'pending_maturity' && sampleCount === 0) {
    blockers.push('current_route_cohort_waiting_for_mature_outcomes')
  }
  const priorSampleCount = Number(priorRow?.paired_sample_count ?? priorRow?.sample_count ?? 0)
  return {
    mechanism: 'shadow_a',
    label: 'Shadow A route comparison',
    governance: 'comparison_only',
    auto_promote: false,
    status: row ? String(row.status ?? 'unknown') : 'not_materialized',
    latest_evidence_date: row ? String(row.as_of_date ?? '') || null : null,
    sample_count: sampleCount,
    distinct_dates: Number(row?.paired_date_count ?? row?.date_count ?? 0),
    supported_regimes: stringList(gate.supported_regimes ?? gate.regimes),
    coverage: total > 0 ? sampleCount / total : null,
    incumbent_delta: finite(row?.challenger_incumbent_delta),
    confidence_bound: finite(row?.challenger_incumbent_delta_lcb90),
    blockers,
    artifact_or_packet_checksum: row ? String(row.evidence_artifact_id ?? row.run_id ?? '') || null : null,
    details: {
      run_id: row?.run_id ?? null,
      artifact_version: row?.artifact_version ?? null,
      candidate_route_version: row?.candidate_route_version ?? STRATEGY_ROUTE_CHALLENGER_VERSION,
      train_start_date: row?.train_start_date ?? null,
      train_end_date: row?.train_end_date ?? null,
      oos_start_date: row?.oos_start_date ?? null,
      oos_end_date: row?.oos_end_date ?? null,
      maturity: {
        observed_total_dates: Number(row?.date_count ?? 0),
        observed_paired_dates: Number(row?.paired_date_count ?? 0),
        minimum_train_dates: STRATEGY_ROUTE_MIN_TRAIN_DATES,
        minimum_oos_dates: STRATEGY_ROUTE_MIN_OOS_DATES,
        minimum_total_dates: STRATEGY_ROUTE_MIN_TOTAL_DATES,
      },
      cohort_reset: Boolean(
        row && priorRow &&
        row.candidate_route_version !== priorRow.candidate_route_version &&
        sampleCount === 0 && priorSampleCount > 0
      ),
      prior_cohort: priorRow ? {
        run_id: priorRow.run_id ?? null,
        candidate_route_version: priorRow.candidate_route_version ?? null,
        as_of_date: priorRow.as_of_date ?? null,
        status: priorRow.status ?? null,
        sample_count: priorSampleCount,
        distinct_dates: Number(priorRow.paired_date_count ?? priorRow.date_count ?? 0),
      } : null,
      gate_metadata: gateMetadata,
      gate,
    },
  }
}

type RfsRow = { date: string; market_segment: string | null; evidence: string }

async function rfsClock(env: Bindings): Promise<EvidenceClock> {
  const db = databaseForDataDomain(env, 'core')
  const { results } = await db.prepare(`
    SELECT date, market_segment,
           json_extract(alpha_allocation, '$.rfs_shadow_challenger') AS evidence
      FROM daily_recommendations
     WHERE json_type(alpha_allocation, '$.rfs_shadow_challenger')='object'
     ORDER BY date DESC, rank ASC
     LIMIT 5000
  `).all<RfsRow>()
  const rows = results ?? []
  const packets = rows.map((row) => ({ ...row, packet: jsonRecord(row.evidence) }))
  const dates = [...new Set(packets.map((row) => row.date))]
  const latestDate = dates[0] ?? null
  const latest = packets.filter((row) => row.date === latestDate)
  const latestPacketMap = new Map<string, typeof latest[number]>()
  for (const row of latest) {
    const checksum = String(row.packet.packet_checksum ?? '').trim()
    latestPacketMap.set(checksum || JSON.stringify(row.packet), row)
  }
  const latestPackets = [...latestPacketMap.values()]
  const packetChecksum = latestPackets.length === 1
    ? String(latestPackets[0].packet.packet_checksum ?? '') || null
    : null
  const blockers = [...new Set(latestPackets.flatMap((row) => stringList(row.packet.validation_blockers)))]
  if (latestPackets.some((row) => String(row.packet.status ?? '') === 'shadow_error')) blockers.push('rfs_shadow_builder_error')
  if (latestPackets.length > 1) blockers.push('rfs_packet_mismatch_same_date')
  const candidateCount = latestPackets.reduce(
    (sum, row) => sum + Math.max(0, Number(row.packet.source_expected_return_candidate_count ?? 0)),
    0,
  )
  const excludedMissingAdv = latestPackets.reduce(
    (sum, row) => sum + stringList(row.packet.excluded_missing_adv_symbols).length,
    0,
  )
  const usableCandidateCount = Math.max(0, candidateCount - excludedMissingAdv)
  const uniqueBlockers = [...new Set(blockers)]
  const status = !latestPackets.length
    ? 'not_materialized'
    : latestPackets.length > 1
      ? 'blocked_mixed_packets'
      : candidateCount === 0
        ? 'observed_zero_candidates'
        : uniqueBlockers.length
          ? 'blocked'
          : 'collecting'
  return {
    mechanism: 'rfs_allocator',
    label: 'RFS allocator comparison',
    governance: 'comparison_only',
    auto_promote: false,
    status,
    latest_evidence_date: latestDate,
    sample_count: candidateCount,
    distinct_dates: dates.length,
    supported_regimes: [...new Set(packets.map((row) => String(row.market_segment ?? '')).filter(Boolean))],
    coverage: candidateCount > 0 ? usableCandidateCount / candidateCount : null,
    incumbent_delta: null,
    confidence_bound: null,
    blockers: uniqueBlockers,
    artifact_or_packet_checksum: packetChecksum,
    details: {
      latest_recommendation_rows: latest.length,
      latest_packet_count: latestPackets.length,
      candidate_count: candidateCount,
      usable_candidate_count: usableCandidateCount,
      zero_candidate_run_materialized: latestPackets.length === 1 && candidateCount === 0,
      packet_statuses: latestPackets.map((row) => String(row.packet.status ?? 'unknown')),
      production_effect: false,
    },
  }
}

type IntentRow = { trade_date: string; symbol: string; side: string; status: string }

async function executionParityClock(env: Bindings): Promise<EvidenceClock> {
  const paperDb = databaseForDataDomain(env, 'paper')
  const executionDb = databaseForDataDomain(env, 'execution')
  const [paperResult, realResult] = await Promise.all([
    paperDb.prepare(`SELECT trade_date, symbol, lower(side) AS side, status
      FROM paper_order_intents WHERE trade_date >= date('now', '-30 days')
      ORDER BY trade_date DESC, symbol`).all<IntentRow>(),
    executionDb.prepare(`SELECT trade_date, symbol, lower(side) AS side, status
      FROM broker_execution_intents WHERE trade_date >= date('now', '-30 days')
      ORDER BY trade_date DESC, symbol`).all<IntentRow>(),
  ])
  const paper = paperResult.results ?? []
  const real = realResult.results ?? []
  const realKeys = new Set(real.map((row) => `${row.trade_date}|${row.symbol}|${row.side}`))
  const paperKeys = new Set(paper.map((row) => `${row.trade_date}|${row.symbol}|${row.side}`))
  const matched = real.filter((row) => paperKeys.has(`${row.trade_date}|${row.symbol}|${row.side}`)).length
  const unmatched = [...realKeys].filter((key) => !paperKeys.has(key)).length
  const latest = [...paper.map((row) => row.trade_date), ...real.map((row) => row.trade_date)].sort().at(-1) ?? null
  return {
    mechanism: 'execution_parity',
    label: 'Execution parity',
    governance: 'manual_only',
    auto_promote: false,
    status: real.length === 0 ? 'not_applicable_no_real_intents' : 'safety_boundary_violation_real_intents_present',
    latest_evidence_date: latest,
    sample_count: real.length,
    distinct_dates: new Set(real.map((row) => row.trade_date)).size,
    supported_regimes: [],
    coverage: real.length ? matched / real.length : null,
    incumbent_delta: null,
    confidence_bound: null,
    blockers: real.length ? ['real_execution_intents_present', ...(unmatched ? [`unmatched_real_intents:${unmatched}`] : [])] : [],
    artifact_or_packet_checksum: null,
    details: { real_intents: real.length, paper_intents: paper.length, matched_intents: matched, production_effect: false },
  }
}

export async function buildShadowEvidenceClockReport(env: Bindings): Promise<EvidenceClockReport> {
  const results = await Promise.all([
    shadowAClock(env).catch((error) => unavailable('shadow_a', 'Shadow A route comparison', 'comparison_only', error)),
    rfsClock(env).catch((error) => unavailable('rfs_allocator', 'RFS allocator comparison', 'comparison_only', error)),
    executionParityClock(env).catch((error) => unavailable('execution_parity', 'Execution parity', 'manual_only', error)),
  ])
  return {
    success: true,
    mode: 'read_only',
    schema_version: 'shadow-evidence-clocks-v1',
    generated_at: new Date().toISOString(),
    clocks_are_independent: true,
    production_effect: false,
    clocks: results,
  }
}
