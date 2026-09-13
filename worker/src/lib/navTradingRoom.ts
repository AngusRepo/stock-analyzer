import type { NavAccountView, NavComparisonDetail, NavFillView } from './navTradingRoomContract'

type Row = { pair_id: string; session_date: string; snapshot_id: string; previous_checksum: string | null;
  payload_json: string; payload_checksum: string }
const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
  .map(v => v.toString(16).padStart(2, '0')).join('')

// Preserve Python's original number spelling (including large integers). Never
// JSON.stringify a parsed Python receipt to verify its content checksum.
export function rawTopLevelValue(raw: string, key: string): string {
  JSON.parse(raw)
  let depth = 0, quoted = false, escaped = false, start = -1
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') {
        quoted = false
        if (depth === 1 && start >= 0 && JSON.parse(raw.slice(start, i + 1)) === key) {
          let j = i + 1
          while (/\s/.test(raw[j] ?? '') && j < raw.length) j++
          if (raw[j] !== ':') continue
          const from = j + 1
          let nested = 0, inString = false, escape = false
          for (j = from; j < raw.length; j++) {
            const token = raw[j]
            if (inString) {
              if (escape) escape = false
              else if (token === '\\') escape = true
              else if (token === '"') inString = false
            } else if (token === '"') inString = true
            else if (token === '{' || token === '[') nested++
            else if (token === '}' || token === ']') {
              if (nested === 0) return raw.slice(from, j).trim()
              nested--
            } else if (token === ',' && nested === 0) return raw.slice(from, j).trim()
          }
        }
      }
    } else if (c === '"') { quoted = true; start = i }
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
  }
  throw new Error('receipt_content_missing')
}

async function readReceipt(db: D1Database, row: Row, journal: any): Promise<any | null> {
  const response = await db.prepare(`SELECT * FROM paired_nav_frozen_manifests_v1
    WHERE snapshot_kind='execution_receipt' AND parent_snapshot_id=? AND signal_date=? LIMIT 2`)
    .bind(row.snapshot_id, row.session_date).all<any>()
  if (!response.success || !Array.isArray(response.results)) throw Error('receipt_query_failed')
  if (!response.results.length) return null
  if (response.results.length !== 1) throw Error('receipt_ambiguous')
  const manifest = response.results[0]
  if (!Number.isInteger(manifest.part_count) || manifest.part_count < 1 || manifest.part_count > 512) throw Error('receipt_parts_invalid')
  const parts = await db.prepare(`SELECT part_no,payload_text FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? ORDER BY part_no LIMIT 513`)
    .bind(manifest.snapshot_id).all<{ part_no: number; payload_text: string }>()
  if (!parts.success || parts.results?.length !== manifest.part_count || parts.results.some((p, i) => p.part_no !== i)) throw Error('receipt_parts_invalid')
  const raw = parts.results.map(p => p.payload_text).join('')
  if (await hash(raw) !== manifest.payload_checksum) throw Error('receipt_checksum_invalid')
  const body = JSON.parse(raw), content = body.content
  if (body.signal_date !== row.session_date || body.snapshot_kind !== 'execution_receipt'
    || body.source_run_id !== manifest.source_run_id || content?.snapshot_id !== row.snapshot_id
    || content?.session_date !== row.session_date || await hash(rawTopLevelValue(raw, 'content')) !== journal.execution_checksum
    || content.arms?.candidate?.complete !== true || content.arms?.baseline?.complete !== true) throw Error('receipt_identity_invalid')
  for (const arm of ['candidate', 'baseline']) {
    if (!Array.isArray(content.arms[arm].fills) || content.arms[arm].fills.length !== journal.arms[arm].fill_count) throw Error('receipt_fills_invalid')
    for (const fill of content.arms[arm].fills) {
      if (typeof fill.fill_id !== 'string' || typeof fill.symbol !== 'string' || !['buy', 'sell'].includes(fill.side)
        || numeric(fill.shares) === null || fill.shares <= 0 || numeric(fill.price) === null || fill.price <= 0) throw Error('receipt_fill_invalid')
    }
  }
  return content
}

function accountView(account: any, marks?: Record<string, unknown>): NavAccountView {
  if (!account || !account.positions || typeof account.positions !== 'object' || Array.isArray(account.positions)) throw Error('account_invalid')
  const positions = Object.entries(account.positions).map(([symbol, shares]) => {
    if (numeric(shares) === null || Number(shares) < 0) throw Error('position_invalid')
    const mark = numeric(marks?.[symbol])
    return { symbol, shares: Number(shares), mark, market_value: mark !== null && mark >= 0 ? mark * Number(shares) : null }
  })
  const nav = numeric(account.nav)
  const value = positions.every(p => p.market_value !== null) ? positions.reduce((sum, p) => sum + p.market_value!, 0) : null
  return { cash: numeric(account.cash), nav, daily_return: numeric(account.daily_return), drawdown: numeric(account.drawdown),
    costs: numeric(account.costs), fill_count: numeric(account.fill_count), positions,
    stock_utilization: nav !== null && nav > 0 && value !== null ? value / nav : null,
    rights_count: Array.isArray(account.corporate_receivables) ? account.corporate_receivables.length : 0 }
}
function fillsView(fills: any[]): NavFillView[] {
  return fills.map(f => ({ fill_id: f.fill_id, symbol: f.symbol, side: f.side, shares: f.shares, price: f.price,
    commission: numeric(f.commission), tax: numeric(f.tax), executed_at: typeof f.executed_at === 'string' ? f.executed_at : null }))
}

/** No replay, registry mutation, gate evaluation or pointer writes. */
export async function readNavComparison(db: D1Database, pairId: string, asOf: string): Promise<NavComparisonDetail> {
  const empty: NavComparisonDetail = { status: 'not_found', pair_id: pairId, as_of: asOf, history_truncated: false, history: [], latest: null, blockers: [] }
  try {
    const result = await db.prepare(`SELECT pair_id,session_date,snapshot_id,previous_checksum,payload_json,payload_checksum
      FROM paired_nav_daily_journal_v1 WHERE pair_id=? AND session_date<=? ORDER BY session_date DESC LIMIT 91`)
      .bind(pairId, asOf).all<Row>()
    if (!result.success || !Array.isArray(result.results)) throw Error('journal_query_failed')
    if (!result.results.length) return empty
    const rows = result.results.reverse(), bodies: any[] = []
    let identity: string | undefined
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], body = JSON.parse(row.payload_json)
      if (await hash(row.payload_json) !== row.payload_checksum || row.pair_id !== pairId || body.pair_id !== pairId
        || body.session_date !== row.session_date || body.snapshot_id !== row.snapshot_id
        || body.previous_checksum !== row.previous_checksum || body.schema_version !== 'paired-nav-journal-v1'
        || body.pair_identity?.pair_id !== pairId || (i > 0 && row.previous_checksum !== rows[i - 1].payload_checksum)
        || (i === 0 && rows.length < 91 && row.previous_checksum !== null)) throw Error('journal_identity_or_chain_invalid')
      const currentIdentity = JSON.stringify(body.pair_identity)
      if (identity && identity !== currentIdentity) throw Error('journal_comparison_changed')
      identity = currentIdentity
      accountView(body.arms?.candidate); accountView(body.arms?.baseline)
      bodies.push(body)
    }
    const latestRow = rows[rows.length - 1], latestBody = bodies[bodies.length - 1]
    let receipt: any = null, receiptStatus: 'verified' | 'missing' | 'invalid' = 'missing'
    try { receipt = await readReceipt(db, latestRow, latestBody); receiptStatus = receipt ? 'verified' : 'missing' }
    catch { receiptStatus = 'invalid' }
    const displayed = rows.length === 91 ? bodies.slice(1) : bodies
    return { ...empty, status: 'available', history_truncated: rows.length === 91,
      history: displayed.map(b => ({ date: b.session_date, candidate_nav: numeric(b.arms.candidate.nav), baseline_nav: numeric(b.arms.baseline.nav),
        candidate_return: numeric(b.arms.candidate.daily_return), baseline_return: numeric(b.arms.baseline.daily_return), net_return_delta: numeric(b.net_return_delta) })),
      latest: { date: latestRow.session_date, candidate: accountView(latestBody.arms.candidate, receipt?.marks),
        baseline: accountView(latestBody.arms.baseline, receipt?.marks), receipt_status: receiptStatus,
        fills: receipt ? { candidate: fillsView(receipt.arms.candidate.fills), baseline: fillsView(receipt.arms.baseline.fills) } : null },
      blockers: receiptStatus === 'verified' ? [] : [`execution_receipt_${receiptStatus}`] }
  } catch {
    return { ...empty, status: 'unavailable', blockers: ['paired_nav_journal_read_or_integrity_failed'] }
  }
}
