// Display-only confidence for recommendation cards (Wei 2026-11-24, X-MEM-CARDSCORE).
// Two readings of the day's R33 roster score, both read from the L4 plan the card came from:
//   1. rank percentile of r33.score among the plan's scored pool, plus how many roster models had z > 0;
//   2. calibrated win rate P(5-session pool-centered excess > 0) from r33DisplayWinRate.json, a static
//      table fitted on the production cohort's sealed OOF. It is shown only when the plan, the
//      live L3 pointer and the table name the same cohort, ensemble and serving calibration.
// Nothing here is read by L3, L4, OPB, risk or order code; it only orders and labels cards.
import displayWinRateTable from './r33DisplayWinRate.json'
import { databaseForDataDomain } from './dataDomainRegistry'
import type { Bindings } from '../types'

export const CONFIDENCE_SORT_MODES = ['l4_ev', 'r33_percentile', 'win_rate', 'legacy_rank'] as const
export type ConfidenceSortMode = typeof CONFIDENCE_SORT_MODES[number]
export const DEFAULT_CONFIDENCE_SORT: ConfidenceSortMode = 'l4_ev'
export const CONFIDENCE_SCHEMA = 'recommendation-confidence-v1'

export function parseConfidenceSort(raw: unknown): ConfidenceSortMode {
  return (CONFIDENCE_SORT_MODES as readonly string[]).includes(String(raw)) ? raw as ConfidenceSortMode : DEFAULT_CONFIDENCE_SORT
}

export interface PlanTargetRow { symbol: string; score: unknown; z: unknown; available: unknown; expected_return_gross: unknown }
export interface PlanHeader {
  plan_id: string
  signal_date: string | null
  cohort_id: string | null
  ensemble_payload_checksum: string | null
  calibration_checksum: string | null
}
export interface PointerIdentity { cohort_id: string; payload_checksum: string }

export interface WinRateSegment { score_lo: number; score_hi: number; win_rate: number; n: number; days_weight: number }
export interface DisplayWinRateTable {
  schema_version: string
  purpose: string
  method?: string
  horizon_sessions: number
  target: string
  model_order: string[]
  identity: { cohort_id: string; ensemble_payload_checksum: string; serving_calibration_checksum: string; [k: string]: unknown }
  segments: WinRateSegment[]
  base_rate: number
  oof: { start: string; end: string; days: number; rows: number }
  validation: Record<string, any>
  table_sha256: string
}

interface PoolEntry {
  score: number | null
  expected_return: number | null
  positive: number
  available: number
  roster: number
}

const finite = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function poolEntry(row: PlanTargetRow): PoolEntry {
  const z = jsonObject(row.z) ?? {}
  const available = jsonObject(row.available) ?? {}
  const models = Object.keys(z)
  let positive = 0
  let count = 0
  for (const model of models) {
    if (available[model] !== true) continue
    const value = finite(z[model])
    if (value == null) continue
    count += 1
    if (value > 0) positive += 1
  }
  return {
    score: finite(row.score),
    expected_return: finite(row.expected_return_gross),
    positive,
    available: count,
    roster: models.length,
  }
}

export function validateDisplayWinRateTable(table: unknown): string | null {
  const t = table as DisplayWinRateTable
  if (!t || t.schema_version !== 'r33-display-win-rate-v1' || t.purpose !== 'display_only') return 'table_schema_invalid'
  if (!t.identity || typeof t.identity.cohort_id !== 'string' || typeof t.identity.ensemble_payload_checksum !== 'string'
    || typeof t.identity.serving_calibration_checksum !== 'string') return 'table_identity_missing'
  if (!/^[0-9a-f]{64}$/.test(String(t.table_sha256 ?? ''))) return 'table_checksum_missing'
  const segments = Array.isArray(t.segments) ? t.segments : []
  if (!segments.length) return 'table_segments_empty'
  let previous: WinRateSegment | null = null
  for (const segment of segments) {
    const values = [segment?.score_lo, segment?.score_hi, segment?.win_rate]
    if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'table_segment_invalid'
    if (segment.score_lo > segment.score_hi || segment.win_rate < 0 || segment.win_rate > 1) return 'table_segment_invalid'
    if (previous && segment.score_lo <= previous.score_hi) return 'table_segments_overlap'
    previous = segment
  }
  return null
}

export function winRateUnavailableReason(table: unknown, header: PlanHeader | null, pointer: PointerIdentity | null | undefined): string | null {
  const invalid = validateDisplayWinRateTable(table)
  if (invalid) return invalid
  const identity = (table as DisplayWinRateTable).identity
  if (!header) return 'plan_unavailable'
  if (header.cohort_id !== identity.cohort_id) return 'plan_cohort_mismatch'
  if (header.ensemble_payload_checksum !== identity.ensemble_payload_checksum) return 'plan_ensemble_mismatch'
  if (header.calibration_checksum !== identity.serving_calibration_checksum) return 'plan_serving_calibration_mismatch'
  if (pointer === undefined || pointer === null) return 'l3_pointer_unavailable'
  if (pointer.cohort_id !== identity.cohort_id || pointer.payload_checksum !== identity.ensemble_payload_checksum) return 'l3_pointer_cohort_mismatch'
  return null
}

export function lookupWinRate(table: DisplayWinRateTable, score: number): { win_rate: number; segment: number; n: number } {
  const segments = table.segments
  let index = 0
  for (let i = 0; i < segments.length; i += 1) if (score >= segments[i].score_lo) index = i
  return { win_rate: segments[index].win_rate, segment: index, n: segments[index].n }
}

export interface ConfidenceContext {
  header: PlanHeader | null
  pool: Map<string, PoolEntry>
  sortedScores: number[]
  winRateReason: string | null
  table: DisplayWinRateTable
  unavailableReason: string | null
}

export function buildConfidenceContext(input: {
  header: PlanHeader | null
  targets: PlanTargetRow[]
  pointer: PointerIdentity | null | undefined
  table?: unknown
  unavailableReason?: string | null
}): ConfidenceContext {
  const table = (input.table ?? displayWinRateTable) as DisplayWinRateTable
  const pool = new Map<string, PoolEntry>()
  for (const row of input.targets) pool.set(String(row.symbol), poolEntry(row))
  const sortedScores = [...pool.values()].map((entry) => entry.score).filter((v): v is number => v != null).sort((a, b) => a - b)
  return {
    header: input.header,
    pool,
    sortedScores,
    table,
    winRateReason: winRateUnavailableReason(table, input.header, input.pointer),
    unavailableReason: input.unavailableReason ?? (input.header ? null : 'plan_unavailable'),
  }
}

// The table's own fitting method (tools/r33_display_win_rate.py METHOD_*), so the label follows the table.
export function winRateDefinition(table: DisplayWinRateTable): string {
  const segments = table.segments.length
  if (table.method === 'serving-hinge-knot-two-segments-each-day-equal-v1') {
    return `P(5 日池內超額報酬 > 0)，R33 正式 OOF 擬合（以 EV 曲線轉折點分 ${segments} 段、每日等權）`
  }
  return `P(5 日池內超額報酬 > 0)，R33 正式 OOF 擬合（與 EV 同 ${segments} 段分箱、每日等權）`
}

function countBelow(sorted: number[], value: number): { below: number; equal: number } {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid }
  let end = lo
  while (end < sorted.length && sorted[end] === value) end += 1
  return { below: lo, equal: end - lo }
}

export function confidenceForSymbol(context: ConfidenceContext, symbol: string) {
  const header = context.header
  const base = {
    schema_version: CONFIDENCE_SCHEMA,
    display_only: true,
    plan_id: header?.plan_id ?? null,
    signal_date: header?.signal_date ?? null,
  }
  const entry = context.pool.get(symbol)
  const reason = context.unavailableReason ?? (!entry ? 'symbol_not_in_plan' : entry.score == null ? 'r33_score_unavailable' : null)
  if (reason || !entry || entry.score == null) {
    return {
      ...base,
      l4_expected_return: entry?.expected_return ?? null,
      r33_score: null,
      percentile: { status: 'unavailable', reason },
      win_rate: { status: 'unavailable', reason: reason ?? context.winRateReason },
    }
  }
  const n = context.sortedScores.length
  const { below, equal } = countBelow(context.sortedScores, entry.score)
  // Mid-rank percentile: share of the scored pool below this score, ties split evenly (top of a unique pool = 100).
  const percentile = n > 1 ? (100 * (below + (equal - 1) / 2)) / (n - 1) : 100
  const rank = n - (below + equal) + 1
  const winRate = context.winRateReason
    ? { status: 'unavailable', reason: context.winRateReason }
    : (() => {
        const hit = lookupWinRate(context.table, entry.score)
        return {
          status: 'available',
          value: hit.win_rate,
          segment: hit.segment,
          segment_count: context.table.segments.length,
          segment_oof_rows: hit.n,
          base_rate: context.table.base_rate,
          horizon_sessions: context.table.horizon_sessions,
          definition: winRateDefinition(context.table),
          oof_start: context.table.oof?.start ?? null,
          oof_end: context.table.oof?.end ?? null,
          table_sha256: context.table.table_sha256,
          cohort_id: context.table.identity.cohort_id,
        }
      })()
  return {
    ...base,
    l4_expected_return: entry.expected_return,
    r33_score: entry.score,
    percentile: {
      status: 'available',
      value: Math.round(percentile * 10) / 10,
      rank,
      pool_size: n,
      models_positive: entry.positive,
      models_available: entry.available,
      roster_size: entry.roster,
      definition: '當日全池 R33 分數排名百分位（分母＝當日有 R33 分數的檔數）；一致度＝可用模型中 z>0 的數量',
    },
    win_rate: winRate,
  }
}

export type RecommendationConfidence = ReturnType<typeof confidenceForSymbol>

function sortValue(rec: Record<string, any>, mode: ConfidenceSortMode): number | null {
  const confidence = rec.r33_confidence as RecommendationConfidence | undefined
  if (mode === 'l4_ev') return finite(confidence?.l4_expected_return)
  if (mode === 'r33_percentile') return finite(confidence?.r33_score)
  if (mode === 'win_rate') return confidence?.win_rate?.status === 'available' ? finite((confidence.win_rate as any).value) : null
  return null
}

/** Descending by the mode's value (unavailable last); ties by R33 score, then the legacy rank. */
export function sortRecommendationsByConfidence<T extends Record<string, any>>(recs: T[], mode: ConfidenceSortMode): T[] {
  const legacy = (rec: T) => finite(rec.rank) ?? Number.POSITIVE_INFINITY
  return recs.map((rec, index) => ({ rec, index })).sort((a, b) => {
    if (mode !== 'legacy_rank') {
      for (const key of mode === 'r33_percentile' ? [mode] : [mode, 'r33_percentile' as const]) {
        const va = sortValue(a.rec, key)
        const vb = sortValue(b.rec, key)
        if (va == null && vb != null) return 1
        if (vb == null && va != null) return -1
        if (va != null && vb != null && va !== vb) return vb - va
      }
    }
    return legacy(a.rec) - legacy(b.rec) || a.index - b.index
  }).map(({ rec }) => rec)
}

function planIdOf(rec: Record<string, any>): string | null {
  const allocation = jsonObject(rec.alpha_allocation)
  const planId = allocation?.plan_id
  return typeof planId === 'string' && planId.trim() ? planId.trim() : null
}

/** Reads the plan the day's cards came from (PAPER_DB, one PK row plus its targets) and the L3 pointer. */
export async function loadConfidenceContext(env: Pick<Bindings, 'DB'> & Partial<Bindings>, date: string, recs: Array<Record<string, any>>): Promise<ConfidenceContext> {
  const counts = new Map<string, number>()
  for (const rec of recs) {
    const id = planIdOf(rec)
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const paper = databaseForDataDomain(env, 'paper')
  let planId = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  try {
    if (!planId) {
      const row = await paper.prepare('SELECT plan_id FROM l4_portfolio_plans_v1 WHERE account_id=1 AND signal_date=? AND activated=1 ORDER BY rowid DESC LIMIT 1')
        .bind(date).first<{ plan_id: string }>()
      planId = row?.plan_id ?? null
    }
    if (!planId) return buildConfidenceContext({ header: null, targets: [], pointer: null })
    const [headerRow, targetRows, pointer] = await Promise.all([
      paper.prepare(`SELECT plan_id,
                            json_extract(payload_json,'$.signal_date') AS signal_date,
                            json_extract(payload_json,'$.l3_identity.cohort_id') AS cohort_id,
                            json_extract(payload_json,'$.l3_identity.payload_checksum') AS ensemble_payload_checksum,
                            json_extract(payload_json,'$.r33_projection.calibration_checksum') AS calibration_checksum
                       FROM l4_portfolio_plans_v1 WHERE plan_id=?`).bind(planId).first<PlanHeader>(),
      paper.prepare(`SELECT j.key AS symbol,
                            json_extract(j.value,'$.r33.score') AS score,
                            json_extract(j.value,'$.r33.z') AS z,
                            json_extract(j.value,'$.r33.available') AS available,
                            json_extract(j.value,'$.expected_return_gross') AS expected_return_gross
                       FROM l4_portfolio_plans_v1 p, json_each(p.payload_json,'$.targets') j
                      WHERE p.plan_id=?`).bind(planId).all<PlanTargetRow>(),
      databaseForDataDomain(env, 'learning')
        .prepare('SELECT cohort_id, payload_checksum FROM active8_ensemble_pointer_v1 WHERE singleton_id=1')
        .first<PointerIdentity>()
        .catch((error) => {
          console.warn('[recommendations/confidence] L3 pointer unavailable:', error)
          return undefined
        }),
    ])
    if (!headerRow) return buildConfidenceContext({ header: null, targets: [], pointer: null, unavailableReason: 'plan_not_found' })
    return buildConfidenceContext({ header: headerRow, targets: targetRows.results ?? [], pointer })
  } catch (error) {
    console.warn('[recommendations/confidence] plan targets unavailable:', error)
    return buildConfidenceContext({ header: null, targets: [], pointer: null, unavailableReason: 'plan_read_failed' })
  }
}
