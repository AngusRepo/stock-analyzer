/** Pre-trade ownership evidence, in the existing account-scoped event ledger.
 * Written inside the corporate session transaction, never reconstructed from
 * today's position. Missing legacy evidence is null, NOT an empty account.
 */
import { paperExecutionNow } from './paperExecutionScope'

const OWNER = 'paper_corporate_actions_v1'
const EVENT = 'corporate_opening_basis'

export interface CorporateOpeningBasis {
  schema_version: 'paper-corporate-opening-basis-v1'
  account_id: number
  session_date: string
  observed_at: string
  source_checksum: string
  positions: Array<Record<string, unknown>>
}

async function checksum(raw: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function validate(basis: CorporateOpeningBasis, accountId: number, sessionDate: string): void {
  if (!basis || typeof basis !== 'object') throw new Error('paper_corporate_opening_basis_invalid')
  const time = Date.parse(basis.observed_at)
  if (basis.schema_version !== 'paper-corporate-opening-basis-v1'
    || !Number.isSafeInteger(accountId) || accountId <= 0 || basis.account_id !== accountId
    || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate) || !Number.isFinite(Date.parse(sessionDate))
    || new Date(sessionDate).toISOString().slice(0, 10) !== sessionDate || basis.session_date !== sessionDate
    || !Number.isFinite(time) || new Date(time).toISOString() !== basis.observed_at
    || new Date(time + 8 * 3600_000).toISOString().slice(0, 10) !== sessionDate
    || time >= Date.parse(sessionDate + 'T01:00:00Z')
    || !/^[a-f0-9]{64}$/.test(basis.source_checksum) || !Array.isArray(basis.positions)) {
    throw new Error('paper_corporate_opening_basis_invalid')
  }
  const symbols = new Set<string>()
  for (const position of basis.positions) {
    if (!position || position.account_id !== accountId || typeof position.symbol !== 'string'
      || !/^[0-9A-Za-z]{4,8}$/.test(position.symbol) || symbols.has(position.symbol)
      || typeof position.shares !== 'number' || !Number.isSafeInteger(position.shares) || position.shares <= 0
      || typeof position.avg_cost !== 'number' || !Number.isFinite(position.avg_cost) || position.avg_cost < 0) {
      throw new Error('paper_corporate_opening_position_invalid')
    }
    symbols.add(position.symbol)
  }
}

export async function prepareCorporateOpeningBasis(db: D1Database, basis: CorporateOpeningBasis): Promise<D1PreparedStatement> {
  validate(basis, basis.account_id, basis.session_date)
  // Serialize now, before the caller adjusts cost/stops/shares for today's event.
  const raw = JSON.stringify({ ...basis, positions: [...basis.positions]
    .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol))) })
  return db.prepare(`INSERT INTO paper_execution_events
    (account_id,trade_date,event_type,status,reason,detail_json,source,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(basis.account_id, basis.session_date, EVENT, 'recorded', await checksum(raw), raw, OWNER, basis.observed_at)
}

interface OpeningEvent {
  id: number; trade_date: string; detail_json: string; reason: string; source: string; status: string
  created_at: string; committed_source_checksum: string | null; processed_at: string | null
}

const eventQuery = `SELECT e.id,e.trade_date,e.detail_json,e.reason,e.source,e.status,e.created_at,
  s.source_checksum AS committed_source_checksum,s.processed_at FROM paper_execution_events e
  LEFT JOIN paper_corporate_sessions_v1 s ON s.account_id=e.account_id AND s.session_date=e.trade_date`

async function decodeEvent(event: OpeningEvent, accountId: number, sessionDate: string,
  asOfMs: number): Promise<CorporateOpeningBasis> {
  if (event.source !== OWNER || event.status !== 'recorded' || typeof event.detail_json !== 'string'
    || await checksum(event.detail_json) !== event.reason) throw new Error('paper_corporate_opening_basis_corrupt')
  const basis: CorporateOpeningBasis = JSON.parse(event.detail_json)
  validate(basis, accountId, sessionDate)
  if (!Number.isFinite(asOfMs) || Date.parse(basis.observed_at) > asOfMs) {
    throw new Error('paper_corporate_opening_basis_not_observable')
  }
  if (event.committed_source_checksum !== basis.source_checksum || event.created_at !== basis.observed_at
    || event.processed_at !== basis.observed_at) throw new Error('paper_corporate_opening_basis_uncommitted')
  return basis
}

export async function readCorporateOpeningBasis(db: D1Database, accountId: number,
  sessionDate: string, asOfMs = paperExecutionNow()): Promise<CorporateOpeningBasis | null> {
  const events = await db.prepare(eventQuery + ' WHERE e.account_id=? AND e.trade_date=? AND e.event_type=? ORDER BY e.id')
    .bind(accountId, sessionDate, EVENT).all<OpeningEvent>()
  if (!events.success || !Array.isArray(events.results)) throw new Error('paper_corporate_opening_basis_read_failed')
  if (!events.results.length) return null
  if (events.results.length !== 1) throw new Error('paper_corporate_opening_basis_ambiguous')
  return decodeEvent(events.results[0], accountId, sessionDate, asOfMs)
}

/** Discovery dates, NOT quantities or permission to book a dividend.
 * Exhaust account-scoped history with keyset pagination; no arbitrary lookback
 * or current-holding fallback. Accounting must still consume its own basis.
 */
export async function readCorporateCashDiscoveryDates(db: D1Database, accountId: number,
  beforeDate: string, asOfMs = paperExecutionNow()): Promise<Record<string, string[]>> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)
    || !Number.isFinite(Date.parse(beforeDate)) || new Date(beforeDate).toISOString().slice(0, 10) !== beforeDate
    || !Number.isFinite(asOfMs)) throw new Error('paper_corporate_opening_basis_invalid')
  let cursor = 0
  const dates = new Map<string, Set<string>>(), sessions = new Set<string>()
  while (true) {
    const page = await db.prepare(eventQuery +
      ' WHERE e.account_id=? AND e.event_type=? AND e.trade_date<? AND e.id>? ORDER BY e.id LIMIT 100')
      .bind(accountId, EVENT, beforeDate, cursor).all<OpeningEvent>()
    if (!page.success || !Array.isArray(page.results)) throw new Error('paper_corporate_opening_basis_read_failed')
    if (!page.results.length) break
    for (const event of page.results) {
      if (!Number.isSafeInteger(event.id) || event.id <= cursor || event.trade_date >= beforeDate
        || sessions.has(event.trade_date)) throw new Error('paper_corporate_opening_basis_ambiguous')
      const basis = await decodeEvent(event, accountId, event.trade_date, asOfMs)
      sessions.add(event.trade_date)
      cursor = event.id
      for (const position of basis.positions) {
        const symbol = String(position.symbol)
        if (!dates.has(symbol)) dates.set(symbol, new Set())
        dates.get(symbol)!.add(basis.session_date)
      }
    }
  }
  return Object.fromEntries([...dates].sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, values]) => [symbol, [...values].sort()]))
}
