import { databaseForDataDomain } from './dataDomainRegistry'
import type { S12IntradayAssessment } from './s12IntradayStructure'

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function positiveNumber(value: unknown): number | null {
  const n = finiteNumber(value)
  return n != null && n > 0 ? n : null
}

function detailPairs(detail: unknown): Record<string, string> {
  const text = String(detail ?? '').trim()
  if (!text) return {}
  const out: Record<string, string> = {}
  for (const part of text.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function boolFromDetail(value: unknown): boolean | null {
  const text = String(value ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(text)) return true
  if (['false', '0', 'no', 'n'].includes(text)) return false
  return null
}

function listFromDetail(value: unknown): string[] {
  const text = String(value ?? '').trim()
  return text ? text.split('|').map((item) => item.trim()).filter(Boolean) : []
}

export function buildS12SnapshotEntryContext(assessment: S12IntradayAssessment): Record<string, unknown> {
  const parts = detailPairs(assessment.detail)
  return {
    schema_version: 's12-equity-mutation-context-v1',
    source: 's12_structure_snapshots',
    engine_version: assessment.engineVersion ?? null,
    state: assessment.state,
    entry_state: assessment.entryState ?? parts.entry_state ?? null,
    ready: assessment.ready,
    session_context_source: assessment.sessionContextSource ?? parts.session_context_source ?? null,
    session_60m_bias: assessment.biasSession60?.direction ?? parts.bias_session_60m ?? null,
    calibration_artifact_id: parts.calibration_artifact_id ?? null,
    calibration_scope: parts.calibration_scope ?? null,
    entry_archetype: parts.entry_archetype ?? null,
    equity_mutation_context: boolFromDetail(parts.equity_mutation_context),
    equity_mutation_score: finiteNumber(parts.equity_mutation_score),
    equity_mutation_reasons: listFromDetail(parts.equity_mutation_reasons),
    equity_mutation_risk_haircuts: listFromDetail(parts.equity_mutation_risk_haircuts),
    vwap_fast_acceptance: boolFromDetail(parts.vwap_fast_acceptance),
    vwap_fast_reasons: listFromDetail(parts.vwap_fast_reasons),
    vwap_slow_context: parts.vwap_slow_context ?? null,
    htf_hard_block: boolFromDetail(parts.htf_hard_block),
    one_h_demand_required: boolFromDetail(parts.one_h_demand_required),
    one_h_demand_role: parts.one_h_demand_role ?? null,
    detail_available: Boolean(String(assessment.detail ?? '').trim()),
  }
}

export async function persistS12StructureSnapshot(
  env: { DB: D1Database },
  params: {
    tradeDate: string
    symbol: string
    assessment: S12IntradayAssessment
    source?: string
    side?: string | null
    pendingRunId?: string | number | null
    metadata?: Record<string, unknown> | null
  },
): Promise<boolean> {
  const assessment = params.assessment
  const source = String(params.source || 's12_intraday_structure_v1')
  const structureStop =
    positiveNumber(assessment.exitPlan?.trailingStop?.initial) ??
    positiveNumber(assessment.execution?.stopLoss)
  const entryContext = buildS12SnapshotEntryContext(assessment)
  try {
    await databaseForDataDomain(env, 'learning').prepare(`
      INSERT INTO s12_structure_snapshots (
        trade_date, symbol, source, side, state, ready, invalidated, setup_id,
        entry_price, chase_ceiling, structure_stop,
        target1_price, target2_price, target3_price, target4_price,
        demand_zone_low, demand_zone_high, supply_zone_low, supply_zone_high,
        detail, entry_context_json, exit_plan_json, raw_json, pending_run_id,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(trade_date, symbol, source) DO UPDATE SET
        side=excluded.side,
        state=excluded.state,
        ready=excluded.ready,
        invalidated=excluded.invalidated,
        setup_id=excluded.setup_id,
        entry_price=excluded.entry_price,
        chase_ceiling=excluded.chase_ceiling,
        structure_stop=excluded.structure_stop,
        target1_price=excluded.target1_price,
        target2_price=excluded.target2_price,
        target3_price=excluded.target3_price,
        target4_price=excluded.target4_price,
        demand_zone_low=excluded.demand_zone_low,
        demand_zone_high=excluded.demand_zone_high,
        supply_zone_low=excluded.supply_zone_low,
        supply_zone_high=excluded.supply_zone_high,
        detail=excluded.detail,
        entry_context_json=excluded.entry_context_json,
        exit_plan_json=excluded.exit_plan_json,
        raw_json=excluded.raw_json,
        pending_run_id=excluded.pending_run_id,
        updated_at=datetime('now')
    `).bind(
      params.tradeDate,
      params.symbol,
      source,
      params.side ?? null,
      assessment.state,
      assessment.ready ? 1 : 0,
      assessment.invalidated ? 1 : 0,
      assessment.setupId ?? null,
      positiveNumber(assessment.execution?.entryPrice),
      positiveNumber(assessment.execution?.chaseCeiling),
      structureStop,
      positiveNumber(assessment.exitPlan?.tp1?.price) ?? positiveNumber(assessment.execution?.target1),
      positiveNumber(assessment.exitPlan?.mainExit?.price) ?? positiveNumber(assessment.execution?.target2),
      positiveNumber(assessment.exitPlan?.tp3?.price) ?? positiveNumber(assessment.execution?.target3),
      positiveNumber(assessment.exitPlan?.tp4?.price) ?? positiveNumber(assessment.execution?.target4),
      positiveNumber(assessment.demandZone1h?.low),
      positiveNumber(assessment.demandZone1h?.high),
      positiveNumber(assessment.supplyZone1h?.low),
      positiveNumber(assessment.supplyZone1h?.high),
      assessment.detail ?? null,
      JSON.stringify(entryContext),
      JSON.stringify(assessment.exitPlan ?? null),
      JSON.stringify(params.metadata ? { ...assessment, runtimeMetadata: params.metadata } : assessment),
      params.pendingRunId == null ? null : String(params.pendingRunId),
    ).run()
    return true
  } catch (error) {
    console.warn('[S12StructureSnapshot] persist skipped:', error instanceof Error ? error.message : String(error))
    return false
  }
}

export async function persistS12UnavailableStructureSnapshot(
  env: { DB: D1Database },
  params: {
    tradeDate: string
    symbol: string
    source?: string
    side?: string | null
    pendingRunId?: string | number | null
    reason: string
    metadata?: Record<string, unknown> | null
  },
): Promise<boolean> {
  const source = String(params.source || 's12_intraday_structure_v1')
  const reason = String(params.reason || 'missing_intraday_bars').trim() || 'missing_intraday_bars'
  const entryContext = {
    schema_version: 's12-equity-mutation-context-v1',
    source: 's12_structure_snapshots',
    state: 'data_unavailable',
    ready: false,
    data_available: false,
    unavailable_reason: reason,
  }
  const raw = {
    schema_version: 's12-structure-unavailable-v1',
    state: 'data_unavailable',
    ready: false,
    invalidated: false,
    reason,
    runtimeMetadata: params.metadata ?? null,
  }

  try {
    await databaseForDataDomain(env, 'learning').prepare(`
      INSERT INTO s12_structure_snapshots (
        trade_date, symbol, source, side, state, ready, invalidated,
        detail, entry_context_json, raw_json, pending_run_id, updated_at
      )
      VALUES (?, ?, ?, ?, 'data_unavailable', 0, 0, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(trade_date, symbol, source) DO UPDATE SET
        side=excluded.side,
        state='data_unavailable',
        ready=0,
        invalidated=0,
        detail=excluded.detail,
        entry_context_json=excluded.entry_context_json,
        raw_json=excluded.raw_json,
        pending_run_id=excluded.pending_run_id,
        updated_at=datetime('now')
    `).bind(
      params.tradeDate,
      params.symbol,
      source,
      params.side ?? null,
      `data_available=false;unavailable_reason=${reason}`,
      JSON.stringify(entryContext),
      JSON.stringify(raw),
      params.pendingRunId == null ? null : String(params.pendingRunId),
    ).run()
    return true
  } catch (error) {
    console.warn('[S12StructureSnapshot] unavailable marker persist failed:', error instanceof Error ? error.message : String(error))
    return false
  }
}
