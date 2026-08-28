import { databaseForDataDomain } from './dataDomainRegistry'
import type { Bindings } from '../types'

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
    SELECT run_id, as_of_date, status, sample_count, date_count,
           paired_sample_count, paired_date_count, challenger_incumbent_delta,
           challenger_incumbent_delta_lcb90, gate_json, evidence_artifact_id
      FROM strategy_route_calibration_runs_v1
     ORDER BY as_of_date DESC, created_at DESC, run_id DESC
     LIMIT 1
  `).first<Record<string, unknown>>()
  const gate = jsonRecord(row?.gate_json)
  const blockers = stringList(gate.failed_gates ?? gate.blockers)
  if (row && ['fail', 'blocked'].includes(String(row.status ?? '').toLowerCase()) && !blockers.length) {
    blockers.push('route_gate_failed_without_structured_blocker')
  }
  const sampleCount = Number(row?.paired_sample_count ?? row?.sample_count ?? 0)
  const total = Number(row?.sample_count ?? 0)
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
    details: { run_id: row?.run_id ?? null, gate },
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
  const ready = latest.filter((row) => !['shadow_error', 'blocked'].includes(String(row.packet.status ?? '')))
  const packetChecksum = latest.map((row) => String(row.packet.packet_checksum ?? '')).find(Boolean) ?? null
  const blockers = [...new Set(latest.flatMap((row) => stringList(row.packet.validation_blockers)))]
  if (latest.some((row) => String(row.packet.status ?? '') === 'shadow_error')) blockers.push('rfs_shadow_builder_error')
  if (latest.length && !ready.length) blockers.push('rfs_no_usable_rows')
  const uniqueBlockers = [...new Set(blockers)]
  return {
    mechanism: 'rfs_allocator',
    label: 'RFS allocator comparison',
    governance: 'comparison_only',
    auto_promote: false,
    status: latest.length ? (uniqueBlockers.length ? 'blocked' : 'collecting') : 'not_materialized',
    latest_evidence_date: latestDate,
    sample_count: latest.length,
    distinct_dates: dates.length,
    supported_regimes: [...new Set(packets.map((row) => String(row.market_segment ?? '')).filter(Boolean))],
    coverage: latest.length ? ready.length / latest.length : null,
    incumbent_delta: null,
    confidence_bound: null,
    blockers: uniqueBlockers,
    artifact_or_packet_checksum: packetChecksum,
    details: { latest_ready_rows: ready.length, production_effect: false },
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
