import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyFinLabStyleFactorNormalization } from '../worker/src/lib/marketScreener'
import {
  STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION,
  buildMultiStrategyPleRoutingPlan,
  type MultiStrategyPleAnnotatedCandidate,
} from '../worker/src/lib/multiStrategyPleRouter'
import { registryRowToStrategySpec } from '../worker/src/lib/strategyLearning'
import type { StrategyCandidatePoolCandidate } from '../worker/src/lib/strategyCandidatePool'
import type { StrategyRawSignals, StrategySpec } from '../worker/src/lib/strategySpec'

const LEARNING_DB = 'stockvision-learning-db'
const OPS_DB = 'stockvision-ops-db'
const WRANGLER = join('worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const OUT_DIR = join('output', 'l1_l15_route_repair_comparison')
const OUTPUT = join(OUT_DIR, 'semantic_v5_evidence_rows.json')
const RECEIPT = join(OUT_DIR, 'semantic_v5_replay_receipt.json')
const ROUTE_VERSION = 'strategy-semantic-continuous-affinity-v5'
const AFFINITY_VERSION = 'strategy-threshold-margin-affinity-v2'
const REFERENCE_CONTRACT = 'selection-reference-snapshot-v3'
const PARITY_EPSILON = 1e-8

function flag(name: string, fallback = ''): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback
}

function sqlText(value: unknown): string {
  return String(value ?? '').replaceAll("'", "''")
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function query(database: string, sql: string): Array<Record<string, any>> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = execFileSync(
        process.execPath,
        [WRANGLER, 'd1', 'execute', database, '--remote', '--json', '--command', sql],
        { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env: process.env, timeout: 60_000 },
      )
      const start = raw.indexOf('[')
      if (start < 0) throw new Error('d1_json_payload_missing:' + database)
      const payload = JSON.parse(raw.slice(start))
      if (!payload?.[0]?.success) throw new Error('d1_query_failed:' + database)
      if (Number(payload[0]?.meta?.rows_written ?? 0) !== 0 || Number(payload[0]?.meta?.changes ?? 0) !== 0) {
        throw new Error('read_only_contract_violated:' + database)
      }
      return payload[0].results ?? []
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function parseRawSignals(value: unknown): StrategyRawSignals {
  const raw = JSON.parse(String(value ?? '{}')) as StrategyRawSignals
  const factors = raw.factorSignals ?? {}
  for (const field of [
    'ebitda', 'nonCurrentAssets', 'cashAndCashEquivalentsIncreaseDecrease',
    'otherPayables', 'currentLiabilities', 'propertyPlantEquipment',
    'operatingExpenses', 'operatingCashFlowStatement', 'workingCapital',
    'freeCashFlow', 'financialCost', 'capitalAmount', 'techGapDown',
  ] as const) {
    if ((raw as any)[field] == null && finite(factors[field]) != null) {
      ;(raw as any)[field] = Number(factors[field])
    }
  }
  if (raw.techGapDown == null && finite(raw.technicalIndicators?.tech_gap_down) != null) {
    raw.techGapDown = Number(raw.technicalIndicators!.tech_gap_down)
  }
  return raw
}

function candidate(row: Record<string, any>): StrategyCandidatePoolCandidate {
  const rawSignals = parseRawSignals(row.raw_signals_json)
  return {
    symbol: String(row.symbol).trim().toUpperCase(),
    industry: row.industry == null ? undefined : String(row.industry),
    market_segment: row.market_segment == null ? null : String(row.market_segment),
    current_price: finite(row.current_price),
    score_v2: rawSignals.score_v2,
    raw_signals: rawSignals,
    eligible_for_ml: true,
    restricted: false,
  }
}

function bySymbol(rows: MultiStrategyPleAnnotatedCandidate[]): Map<string, MultiStrategyPleAnnotatedCandidate> {
  return new Map(rows.map((row) => [String(row.symbol).trim().toUpperCase(), row]))
}

if (STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION !== ROUTE_VERSION) {
  throw new Error('router_route_version_mismatch:' + STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION)
}

const asOfDate = flag('--as-of', new Date().toISOString().slice(0, 10))
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error('invalid_as_of_date:' + asOfDate)
const onlyDates = new Set(flag('--dates').split(',').map((value) => value.trim()).filter(Boolean))
const heads = query(OPS_DB, [
  "SELECT substr(logical_run_key,10,10) signal_date, run_id",
  "FROM canonical_run_heads",
  "WHERE logical_run_key GLOB 'screener:????-??-??:TW:production:market_screener'",
  "AND substr(logical_run_key,10,10) <= '" + sqlText(asOfDate) + "'",
  'ORDER BY signal_date',
].join(' '))
const canonical = Object.fromEntries(heads.map((row) => [String(row.signal_date), String(row.run_id)]))
const dates = heads.map((row) => String(row.signal_date)).filter((date) => !onlyDates.size || onlyDates.has(date))
const registry = query(LEARNING_DB, [
  'SELECT strategy_id, version, name, status, owner, alpha_bucket, family_id, variant_id,',
  'owner_type, promotion_status, supported_regimes_json, thesis, thresholds_json,',
  'candidate_policy_json, risk_notes_json, source_refs_json, created_by, created_at, updated_at',
  'FROM strategy_spec_registry WHERE status <> \'retired\' ORDER BY strategy_id, version',
].join(' ')).map((row) => registryRowToStrategySpec(row as any) as StrategySpec)

const evidenceRows: Array<Record<string, any>> = []
const accepted: Array<Record<string, any>> = []
const rejected: Array<Record<string, any>> = []

for (const signalDate of dates) {
  const runId = canonical[signalDate]
  const matrix = query(LEARNING_DB, [
    'SELECT status,expected_cell_count,persisted_cell_count,reference_contract_version,payload_checksum',
    "FROM strategy_label_matrix_runs_v4 WHERE producer_run_id='" + sqlText(runId) + "' LIMIT 1",
  ].join(' '))[0]
  if (!matrix || matrix.status !== 'ready' || Number(matrix.expected_cell_count) <= 0
      || Number(matrix.expected_cell_count) !== Number(matrix.persisted_cell_count)
      || !/^sha256:[a-f0-9]{64}$/.test(String(matrix.payload_checksum ?? ''))) {
    rejected.push({ signal_date: signalDate, producer_run_id: runId, reason: 'matrix_not_immutable_ready' })
    continue
  }
  const rows = query(LEARNING_DB, [
    'WITH context_owner AS (',
    'SELECT symbol, MIN(context_id) context_id, COUNT(DISTINCT context_id) context_count',
    "FROM strategy_decision_log WHERE date='" + sqlText(signalDate) + "' GROUP BY symbol",
    ') SELECT r.symbol,r.market_segment,r.strategy_router_version,r.strategy_router_score,',
    'r.strategy_challenger_affinity_version,o.context_count,c.context_id,c.context_hash,',
    'c.raw_signals_json,c.current_price,c.industry,c.artifact_id,c.r2_key,c.checksum,',
    'l.absolute_return_net,l.residual_return_net,l.outcome_known_date',
    'FROM selection_reference_snapshots_v1 r',
    'LEFT JOIN context_owner o ON o.symbol=r.symbol',
    'LEFT JOIN strategy_candidate_contexts c ON c.context_id=o.context_id',
    'LEFT JOIN canonical_selection_labels_v4 l ON l.signal_date=r.signal_date',
    'AND l.symbol=r.symbol AND l.producer_run_id=r.producer_run_id',
    "WHERE r.signal_date='" + sqlText(signalDate) + "'",
    "AND r.producer_run_id='" + sqlText(runId) + "'",
    "AND r.strategy_matrix_status='ready' AND r.hard_gate_passed=1",
    'ORDER BY r.symbol',
  ].join(' '))
  const blockers: string[] = []
  if (!rows.length) blockers.push('canonical_hard_gate_references_missing')
  if (rows.some((row) => Number(row.context_count) !== 1 || !row.context_id)) blockers.push('candidate_context_identity_incomplete')
  if (rows.some((row) => !/^sha256:[a-f0-9]{64}$/.test(String(row.context_hash ?? '')))) blockers.push('context_hash_invalid')
  if (rows.some((row) => !/^sha256:[a-f0-9]{64}$/.test(String(row.checksum ?? '')))) blockers.push('artifact_checksum_invalid')
  if (rows.some((row) => !row.artifact_id || !row.r2_key)) blockers.push('artifact_pointer_incomplete')
  if (rows.some((row) => row.strategy_challenger_affinity_version !== AFFINITY_VERSION)) blockers.push('l125_affinity_incomplete')
  if (rows.some((row) => finite(row.strategy_router_score) == null || !row.strategy_router_version)) blockers.push('incumbent_route_missing')
  if (rows.some((row) => finite(row.absolute_return_net) == null || finite(row.residual_return_net) == null)) blockers.push('mature_label_incomplete')
  if (rows.some((row) => String(row.outcome_known_date ?? '') > asOfDate)) blockers.push('outcome_not_known_as_of')
  if (blockers.length) {
    rejected.push({ signal_date: signalDate, producer_run_id: runId, rows: rows.length, reasons: [...new Set(blockers)] })
    continue
  }
  const candidates = rows.map(candidate)
  applyFinLabStyleFactorNormalization(candidates.map((item) => ({
    raw_signals: item.raw_signals as StrategyRawSignals,
    industry: item.industry,
  })))
  const replay = buildMultiStrategyPleRoutingPlan(candidates, registry, {
    maxSlateSize: candidates.length,
    evidenceMode: 'historical_replay',
    minRouteScore: 0,
  })
  const replayBySymbol = bySymbol(replay.l0Annotated)
  let maxParityError = 0
  const dateEvidence: Array<Record<string, any>> = []
  for (const row of rows) {
    const symbol = String(row.symbol).trim().toUpperCase()
    const annotated = replayBySymbol.get(symbol)
    const incumbentReplay = finite(annotated?.strategy_incumbent_route_score)
    const challengerReplay = finite(annotated?.strategy_challenger_route_score)
    const incumbentStored = finite(row.strategy_router_score)
    if (incumbentReplay == null || challengerReplay == null || incumbentStored == null) {
      blockers.push('replay_route_missing:' + symbol)
      break
    }
    maxParityError = Math.max(maxParityError, Math.abs(incumbentReplay - incumbentStored))
    dateEvidence.push({
      route_version: ROUTE_VERSION,
      signal_date: signalDate,
      symbol,
      producer_run_id: runId,
      route_score: challengerReplay,
      incumbent_route_version: String(row.strategy_router_version),
      incumbent_route_score: incumbentStored,
      strategy_spec_version: 'strategy-spec-v2',
      evidence_method: 'deterministic_paired_pit_replay',
      source_reference_contract: REFERENCE_CONTRACT,
    })
  }
  if (blockers.length || maxParityError > PARITY_EPSILON) {
    rejected.push({
      signal_date: signalDate,
      producer_run_id: runId,
      rows: rows.length,
      reasons: blockers.length ? blockers : ['incumbent_replay_parity_mismatch'],
      max_incumbent_parity_error: maxParityError,
    })
    continue
  }
  evidenceRows.push(...dateEvidence)
  accepted.push({
    signal_date: signalDate,
    producer_run_id: runId,
    rows: rows.length,
    matrix_payload_checksum: matrix.payload_checksum,
    context_artifact_checksums: [...new Set(rows.map((row) => String(row.checksum)))].sort(),
    max_incumbent_parity_error: maxParityError,
  })
}

evidenceRows.sort((left, right) => left.signal_date.localeCompare(right.signal_date)
  || left.symbol.localeCompare(right.symbol) || left.producer_run_id.localeCompare(right.producer_run_id))
const receipt = {
  generated_at: new Date().toISOString(),
  contract: 'l1-l15-v5-immutable-deterministic-replay-v1',
  production_effect: false,
  as_of_date: asOfDate,
  route_version: ROUTE_VERSION,
  no_top_k: true,
  score_generation_uses_outcomes: false,
  incumbent_parity_epsilon: PARITY_EPSILON,
  accepted_dates: accepted,
  rejected_dates: rejected,
  evidence_rows: evidenceRows.length,
  evidence_payload_checksum: sha256(JSON.stringify(evidenceRows)),
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUTPUT, JSON.stringify(evidenceRows, null, 2) + '\n', 'utf8')
writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ output: OUTPUT, receipt: RECEIPT, ...receipt }, null, 2))
