import { paperExecutionDate } from './paperExecutionScope'
import type { RiskConfig } from './riskConfig'
import type { CircuitBreakerState, LegacyLayerDeps } from './riskTypes'

export interface IntradayNavState {
  tradeDate: string
  peakNav: number
  lastNav: number
  halted: boolean
  updatedAt: string
}

export interface IntradayDrawdownEvaluation {
  state: IntradayNavState
  drawdown: number
  triggered: boolean
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function evaluateIntradayDrawdown(params: {
  tradeDate: string
  currentNav: number
  currentNavUpperBound?: number
  previous: IntradayNavState | null
  haltThreshold: number
  nowIso?: string
}): IntradayDrawdownEvaluation {
  const currentNav = finitePositive(params.currentNav)
  if (currentNav == null) throw new Error('intraday_nav_invalid')
  const previousPeak = params.previous?.tradeDate === params.tradeDate
    ? finitePositive(params.previous.peakNav)
    : null
  const upper = params.currentNavUpperBound === undefined ? currentNav : finitePositive(params.currentNavUpperBound)
  if (upper == null || upper < currentNav) throw new Error('intraday_nav_bound_invalid')
  // Conservative interval comparison: current lower value versus historical
  // upper peak. Uncertainty can tighten risk, never hide a potential drawdown.
  const peakNav = Math.max(previousPeak ?? upper, upper)
  const drawdown = peakNav > 0 ? (peakNav - currentNav) / peakNav : 0
  const drawdownTriggered = drawdown >= Math.max(0, params.haltThreshold)
  const halted = params.previous?.tradeDate === params.tradeDate && params.previous.halted === true
    ? true
    : drawdownTriggered
  return {
    state: {
      tradeDate: params.tradeDate,
      peakNav,
      lastNav: currentNav,
      halted,
      updatedAt: params.nowIso ?? paperExecutionDate().toISOString(),
    },
    drawdown,
    triggered: halted,
  }
}

function p9HaltState(state: IntradayNavState, deps: LegacyLayerDeps): CircuitBreakerState {
  const drawdown = state.peakNav > 0 ? (state.peakNav - state.lastNav) / state.peakNav : 0
  const reason = `P9 intraday drawdown halt latched for ${state.tradeDate}: ${(drawdown * 100).toFixed(2)}%`
  return {
    ...deps.defaults,
    halt: true,
    maxPositionPct: 0,
    buyConfThreshold: 1,
    sellConfThreshold: 1,
    targetExposurePct: 0,
    deRiskExistingPositions: true,
    triggeredLayers: ['P9'],
    haltReasons: [`[P9] ${reason}`],
    reason,
  }
}

export function unavailableP9Risk(deps: LegacyLayerDeps, reason: string): CircuitBreakerState {
  return { ...deps.defaults, halt: true, maxPositionPct: 0, buyConfThreshold: 1,
    targetExposurePct: null, deRiskExistingPositions: false, triggeredLayers: ['P9'],
    haltReasons: ['[P9] ' + reason], reason: 'P9 risk unavailable: ' + reason }
}

interface P9Row { account_id: number; trade_date: string; peak_nav: number; last_nav: number; halted: number; updated_at: string }
function primaryP9(db: D1Database) {
  // Native D1 without Sessions routes to primary. Explicit sessions must start there too.
  const native = db as D1Database & { withSession?: (constraint: string) => Pick<D1Database, 'prepare'> }
  return native.withSession ? native.withSession('first-primary') : native
}
function navState(row: P9Row): IntradayNavState {
  if (!Number.isFinite(row.peak_nav) || row.peak_nav <= 0 || !Number.isFinite(row.last_nav)
    || row.last_nav <= 0 || row.peak_nav < row.last_nav || ![0,1].includes(row.halted)) throw new Error('p9_state_invalid')
  return {tradeDate: row.trade_date, peakNav: row.peak_nav, lastNav: row.last_nav,
    halted: row.halted === 1, updatedAt: row.updated_at}
}
async function readOrAdoptP9(db: D1Database, kv: KVNamespace, accountId: number, tradeDate: string): Promise<IntradayNavState | null> {
  const row = await primaryP9(db).prepare('SELECT account_id,trade_date,peak_nav,last_nav,halted,updated_at FROM paper_intraday_nav_risk_v1 WHERE account_id=? AND trade_date=?')
    .bind(accountId,tradeDate).first<P9Row>()
  if (row) return navState(row)
  // Legacy KV was global: only the formal account may adopt it. A read error cannot seed a clean state.
  if (accountId !== 1) return null
  const legacy = await kv.get(`risk:intraday_nav_peak:${tradeDate}`, 'json') as IntradayNavState | null
  if (legacy === null) return null
  if (legacy.tradeDate !== tradeDate || typeof legacy.halted !== 'boolean'
    || finitePositive(legacy.peakNav) == null || finitePositive(legacy.lastNav) == null
    || legacy.peakNav < legacy.lastNav) throw new Error('p9_legacy_state_invalid')
  const saved = await primaryP9(db).prepare(`INSERT INTO paper_intraday_nav_risk_v1
    (account_id,trade_date,peak_nav,last_nav,halted,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(account_id,trade_date) DO UPDATE SET
      peak_nav=MAX(paper_intraday_nav_risk_v1.peak_nav,excluded.peak_nav),
      halted=MAX(paper_intraday_nav_risk_v1.halted,excluded.halted)
    RETURNING account_id,trade_date,peak_nav,last_nav,halted,updated_at`)
    .bind(accountId,tradeDate,legacy.peakNav,legacy.lastNav,legacy.halted ? 1 : 0,legacy.updatedAt).first<P9Row>()
  if (!saved) throw new Error('p9_legacy_adoption_unacknowledged')
  return navState(saved)
}

export async function readP9IntradayHalt(
  db: D1Database, kv: KVNamespace, accountId: number, tradeDate: string, deps: LegacyLayerDeps,
): Promise<CircuitBreakerState | null> {
  try {
    if (!Number.isInteger(accountId) || accountId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error('p9_scope_invalid')
    const state = await readOrAdoptP9(db,kv,accountId,tradeDate)
    return state?.halted ? p9HaltState(state,deps) : null
  } catch { return unavailableP9Risk(deps,'authoritative_state_read_failed') }
}

export async function checkP9IntradayDrawdown(
  db: D1Database, kv: KVNamespace, accountId: number, tradeDate: string, currentNav: number,
  riskConfig: RiskConfig, deps: LegacyLayerDeps, currentNavUpperBound?: number,
): Promise<{state: CircuitBreakerState | null; evaluation: IntradayDrawdownEvaluation | null}> {
  try {
    if (!Number.isInteger(accountId) || accountId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error('p9_scope_invalid')
    const lower = finitePositive(currentNav), upper = finitePositive(currentNavUpperBound ?? currentNav)
    const threshold = riskConfig.portfolio.intradayDrawdownHalt
    if (lower == null || upper == null || upper < lower || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error('p9_input_invalid')
    await readOrAdoptP9(db,kv,accountId,tradeDate)
    const now = paperExecutionDate().toISOString()
    // A single write evaluates the latest committed peak and OR-latches halt. Concurrent/stale callers cannot lower either.
    const row = await primaryP9(db).prepare(`INSERT INTO paper_intraday_nav_risk_v1
      (account_id,trade_date,peak_nav,last_nav,halted,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id,trade_date) DO UPDATE SET
        peak_nav=MAX(paper_intraday_nav_risk_v1.peak_nav,excluded.peak_nav),
        last_nav=excluded.last_nav,
        halted=MAX(paper_intraday_nav_risk_v1.halted,
          CASE WHEN (MAX(paper_intraday_nav_risk_v1.peak_nav,excluded.peak_nav)-excluded.last_nav)/MAX(paper_intraday_nav_risk_v1.peak_nav,excluded.peak_nav)>=? THEN 1 ELSE 0 END),
        updated_at=excluded.updated_at
      RETURNING account_id,trade_date,peak_nav,last_nav,halted,updated_at`)
      .bind(accountId,tradeDate,upper,lower,(upper-lower)/upper >= threshold ? 1 : 0,now,threshold).first<P9Row>()
    if (!row) throw new Error('p9_write_unacknowledged')
    const state = navState(row)
    const evaluation = {state, drawdown:(state.peakNav-state.lastNav)/state.peakNav, triggered:state.halted}
    // Observation only. Failed mirrors never reset or hide the authoritative halt.
    await kv.put(`risk:p9:${accountId}:${tradeDate}`,JSON.stringify(state),{expirationTtl:3*86400}).catch(()=>undefined)
    return {state:state.halted ? p9HaltState(state,deps) : null,evaluation}
  } catch { return {state:unavailableP9Risk(deps,'authoritative_state_update_failed'),evaluation:null} }
}

export function mergeIntradayPortfolioRisk(
  base: CircuitBreakerState,
  overlay: CircuitBreakerState | null,
): CircuitBreakerState {
  if (!overlay) return base
  const baseTarget = base.targetExposurePct == null ? 1 : base.targetExposurePct
  const overlayTarget = overlay.targetExposurePct == null ? 1 : overlay.targetExposurePct
  return {
    ...base,
    halt: base.halt || overlay.halt,
    maxPositionPct: Math.min(base.maxPositionPct, overlay.maxPositionPct),
    buyConfThreshold: Math.max(base.buyConfThreshold, overlay.buyConfThreshold),
    sellConfThreshold: Math.max(base.sellConfThreshold, overlay.sellConfThreshold),
    targetExposurePct: Math.min(baseTarget, overlayTarget),
    deRiskExistingPositions: Boolean(base.deRiskExistingPositions || overlay.deRiskExistingPositions),
    triggeredLayers: [...new Set([...(base.triggeredLayers ?? []), ...(overlay.triggeredLayers ?? [])])],
    haltReasons: [...new Set([...(base.haltReasons ?? []), ...(overlay.haltReasons ?? [])])],
    reason: [base.reason, overlay.reason].filter(Boolean).join(' | '),
  }
}
