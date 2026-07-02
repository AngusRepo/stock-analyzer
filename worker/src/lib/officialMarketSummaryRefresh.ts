import type { Bindings } from '../types'

const OFFICIAL_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }

type MarketSummaryRow = {
  date: string
  market_segment: 'LISTED' | 'OTC' | 'ALL'
  advance_count?: number | null
  unchanged_count?: number | null
  decline_count?: number | null
  total_volume?: number | null
  total_value?: number | null
  margin_buy_units?: number | null
  margin_sell_units?: number | null
  margin_return_units?: number | null
  margin_balance_units?: number | null
  margin_buy_value?: number | null
  margin_sell_value?: number | null
  margin_return_value?: number | null
  margin_balance_value?: number | null
  margin_balance_change_pct?: number | null
  short_buy_units?: number | null
  short_sell_units?: number | null
  short_return_units?: number | null
  short_balance_units?: number | null
  short_balance_change_pct?: number | null
  source: string
  lineage_json: string
  as_of_date: string
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null
  const text = String(value).replace(/,/g, '').trim()
  if (!text || text === '-' || text === '--') return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function sumArrayColumn(rows: unknown[], index: number): number | null {
  let total = 0
  let seen = false
  for (const row of rows) {
    if (!Array.isArray(row) || row.length <= index) continue
    const value = numberOrNull(row[index])
    if (value == null) continue
    total += value
    seen = true
  }
  return seen ? total : null
}

function sumObjectField(rows: unknown[], names: string[]): number | null {
  let total = 0
  let seen = false
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    for (const name of names) {
      const value = numberOrNull(item[name])
      if (value == null) continue
      total += value
      seen = true
      break
    }
  }
  return seen ? total : null
}

function arrayValueByHeader(row: unknown[], fields: unknown[], names: string[]): unknown {
  const cleanFields = fields.map((field) => String(field ?? '').replace(/\s+/g, ''))
  const index = cleanFields.findIndex((field) =>
    names.some((name) => field === name || field.startsWith(`${name}(`)),
  )
  if (index >= 0) return row[index]
  const fallbackIndex = cleanFields.findIndex((field) =>
    !field.startsWith('前') && names.some((name) => field.includes(name)),
  )
  return fallbackIndex >= 0 ? row[fallbackIndex] : null
}

function parseOfficialDate(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  const digits = text.replace(/\D/g, '')
  if (/^\d{8}$/.test(digits)) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  if (/^\d{7}$/.test(digits)) {
    const year = Number(digits.slice(0, 3)) + 1911
    return `${year}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  return fallback
}

function compactDate(date: string): string {
  return date.replace(/-/g, '')
}

function rocSlashDate(date: string): string {
  const [year, month, day] = date.split('-')
  return `${Number(year) - 1911}/${month}/${day}`
}

async function officialJson(url: string, label: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: OFFICIAL_HEADERS,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`)
  const text = await res.text()
  const normalized = text.replace(/^\uFEFF/, '').trim()
  if (!normalized || normalized.startsWith('<')) throw new Error(`${label} returned non-json`)
  return JSON.parse(normalized)
}

function lineage(runId: string, source: string, targetDate: string): string {
  return JSON.stringify({
    schema_version: 'official_market_summary_refresh_v1',
    dataset_lane: 'official_market_summary',
    run_id: runId,
    source,
    target_date: targetDate,
  })
}

async function fetchTwseMarginSummaryRow(targetDate: string, runId: string, generatedAt: string): Promise<MarketSummaryRow | null> {
  const day = compactDate(targetDate)
  const body = await officialJson(
    `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${day}&selectType=ALL&response=json`,
    `twse_mi_margn_${day}`,
  )
  if (!body || typeof body !== 'object' || (body as any).stat !== 'OK') return null
  const tables = Array.isArray((body as any).tables) ? (body as any).tables : []
  const table = tables[1] && typeof tables[1] === 'object' ? tables[1] : null
  const rows = Array.isArray(table?.data) ? table.data : []
  if (!rows.length) return null
  return {
    date: parseOfficialDate((body as any).date ?? day, targetDate),
    market_segment: 'LISTED',
    margin_buy_units: sumArrayColumn(rows, 2),
    margin_sell_units: sumArrayColumn(rows, 3),
    margin_return_units: sumArrayColumn(rows, 4),
    margin_balance_units: sumArrayColumn(rows, 6),
    short_buy_units: sumArrayColumn(rows, 8),
    short_sell_units: sumArrayColumn(rows, 9),
    short_return_units: sumArrayColumn(rows, 10),
    short_balance_units: sumArrayColumn(rows, 12),
    source: 'twse.mi_margn.official',
    lineage_json: lineage(runId, 'twse.mi_margn.official', targetDate),
    as_of_date: generatedAt.slice(0, 10),
  }
}

function tpexSummaryRowFromRows(
  rows: unknown[],
  targetDate: string,
  runId: string,
  generatedAt: string,
  sourceDate: string,
): MarketSummaryRow | null {
  if (!rows.length) return null
  return {
    date: sourceDate,
    market_segment: 'OTC',
    margin_buy_units: sumObjectField(rows, ['MarginPurchase', 'margin_buy']),
    margin_sell_units: sumObjectField(rows, ['MarginSales', 'margin_sell']),
    margin_balance_units: sumObjectField(rows, ['MarginPurchaseBalance', 'margin_balance']),
    short_buy_units: sumObjectField(rows, ['ShortBuy', 'ShortCovering', 'short_buy']),
    short_sell_units: sumObjectField(rows, ['ShortSale', 'short_sell']),
    short_balance_units: sumObjectField(rows, ['ShortSaleBalance', 'short_balance']),
    source: 'tpex.margin_balance.official',
    lineage_json: lineage(runId, 'tpex.margin_balance.official', targetDate),
    as_of_date: generatedAt.slice(0, 10),
  }
}

function subtractNumber(total: unknown, listed: unknown): number | null {
  const totalValue = numberOrNull(total)
  const listedValue = numberOrNull(listed)
  if (totalValue == null || listedValue == null) return null
  const value = totalValue - listedValue
  return Number.isFinite(value) ? Math.max(0, value) : null
}

async function deriveOtcSummaryFromCanonicalChip(
  db: D1Database,
  rows: MarketSummaryRow[],
  targetDate: string,
  runId: string,
  generatedAt: string,
): Promise<MarketSummaryRow[]> {
  if (rows.some((row) => row.market_segment === 'OTC' && row.date === targetDate)) return rows
  const listed = rows.find((row) => row.market_segment === 'LISTED' && row.date === targetDate)
  if (!listed) return rows

  const total = await db.prepare(`
    SELECT
      SUM(COALESCE(margin_buy, 0)) AS margin_buy_units,
      SUM(COALESCE(margin_sell, 0)) AS margin_sell_units,
      SUM(COALESCE(margin_cash_repayment, 0)) AS margin_return_units,
      SUM(COALESCE(margin_balance, 0)) AS margin_balance_units,
      SUM(COALESCE(short_buy, 0)) AS short_buy_units,
      SUM(COALESCE(short_sell, 0)) AS short_sell_units,
      SUM(COALESCE(short_stock_repayment, 0)) AS short_return_units,
      SUM(COALESCE(short_balance, 0)) AS short_balance_units,
      COUNT(*) AS rows
    FROM canonical_chip_daily
    WHERE date = ? AND market_segment = 'LISTED_OTC'
  `).bind(targetDate).first<Record<string, unknown>>()
  if (!total || numberOrNull(total.rows) == null || Number(total.rows) <= 0) return rows

  const otc: MarketSummaryRow = {
    date: targetDate,
    market_segment: 'OTC',
    margin_buy_units: subtractNumber(total.margin_buy_units, listed.margin_buy_units),
    margin_sell_units: subtractNumber(total.margin_sell_units, listed.margin_sell_units),
    margin_return_units: subtractNumber(total.margin_return_units, listed.margin_return_units),
    margin_balance_units: subtractNumber(total.margin_balance_units, listed.margin_balance_units),
    short_buy_units: subtractNumber(total.short_buy_units, listed.short_buy_units),
    short_sell_units: subtractNumber(total.short_sell_units, listed.short_sell_units),
    short_return_units: subtractNumber(total.short_return_units, listed.short_return_units),
    short_balance_units: subtractNumber(total.short_balance_units, listed.short_balance_units),
    source: 'finlab.canonical_chip_minus_twse',
    lineage_json: lineage(runId, 'finlab.canonical_chip_minus_twse', targetDate),
    as_of_date: generatedAt.slice(0, 10),
  }
  return [...rows, otc]
}

async function fetchTpexDateSpecificMarginSummaryRow(targetDate: string, runId: string, generatedAt: string): Promise<MarketSummaryRow | null> {
  const body = await officialJson(
    `https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${rocSlashDate(targetDate)}&id=&response=json`,
    `tpex_margin_balance_${targetDate}`,
  )
  const tables = body && typeof body === 'object' && Array.isArray((body as any).tables) ? (body as any).tables : []
  const table = tables[0] && typeof tables[0] === 'object' ? tables[0] : null
  const fields = Array.isArray(table?.fields) ? table.fields : []
  const rawRows = Array.isArray(table?.data) ? table.data : []
  const rows = rawRows
    .filter((row: unknown) => Array.isArray(row) && /^\d{4}$/.test(String(row[0] ?? '').trim()))
    .map((row: any[]) => ({
      margin_buy: arrayValueByHeader(row, fields, ['資買']),
      margin_sell: arrayValueByHeader(row, fields, ['資賣']),
      margin_balance: arrayValueByHeader(row, fields, ['資餘額']),
      short_buy: arrayValueByHeader(row, fields, ['券買']),
      short_sell: arrayValueByHeader(row, fields, ['券賣']),
      short_balance: arrayValueByHeader(row, fields, ['券餘額']),
    }))
  return tpexSummaryRowFromRows(rows, targetDate, runId, generatedAt, targetDate)
}

async function fetchTpexLatestMarginSummaryRow(targetDate: string, runId: string, generatedAt: string): Promise<MarketSummaryRow | null> {
  const body = await officialJson(
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance',
    'tpex_margin_balance',
  )
  const rows = Array.isArray(body) ? body : []
  if (!rows.length) return null
  const first = rows.find((row) => row && typeof row === 'object') as Record<string, unknown> | undefined
  const sourceDate = parseOfficialDate(first?.Date ?? first?.date, targetDate)
  return tpexSummaryRowFromRows(rows, targetDate, runId, generatedAt, sourceDate)
}

async function fetchTpexMarginSummaryRow(targetDate: string, runId: string, generatedAt: string): Promise<MarketSummaryRow | null> {
  try {
    const dateSpecific = await fetchTpexDateSpecificMarginSummaryRow(targetDate, runId, generatedAt)
    if (dateSpecific) return dateSpecific
  } catch (e) {
    console.warn(`[OfficialMarketSummary] TPEX date-specific margin failed for ${targetDate}:`, e)
  }
  try {
    return await fetchTpexLatestMarginSummaryRow(targetDate, runId, generatedAt)
  } catch (e) {
    console.warn(`[OfficialMarketSummary] TPEX latest margin failed for ${targetDate}:`, e)
    return null
  }
}

async function fetchOfficialMarketSummaryRows(targetDate: string, runId: string, generatedAt: string): Promise<MarketSummaryRow[]> {
  const [twse, tpex] = await Promise.all([
    fetchTwseMarginSummaryRow(targetDate, runId, generatedAt),
    fetchTpexMarginSummaryRow(targetDate, runId, generatedAt),
  ])
  return [twse, tpex].filter((row): row is MarketSummaryRow => Boolean(row))
}

function validateTargetDateRows(rows: MarketSummaryRow[], targetDate: string): void {
  const bySegment = new Map(rows.map((row) => [row.market_segment, row.date]))
  const missing: string[] = []
  if (bySegment.get('LISTED') !== targetDate) {
    missing.push(`twse_margin_trading_summary=missing_target_date:${targetDate};date=${bySegment.get('LISTED') ?? 'none'}`)
  }
  if (bySegment.get('OTC') !== targetDate) {
    missing.push(`tpex_margin_trading_summary=missing_target_date:${targetDate};date=${bySegment.get('OTC') ?? 'none'}`)
  }
  if (missing.length) throw new Error(`official_market_summary_missing: ${missing.join('; ')}`)
}

async function upsertMarketSummaryRows(db: D1Database, rows: MarketSummaryRow[]): Promise<void> {
  const statements = rows.map((row) => db.prepare(`
    INSERT INTO canonical_market_summary_daily (
      date, market_segment, advance_count, unchanged_count, decline_count,
      total_volume, total_value,
      margin_buy_units, margin_sell_units, margin_return_units, margin_balance_units,
      margin_buy_value, margin_sell_value, margin_return_value, margin_balance_value, margin_balance_change_pct,
      short_buy_units, short_sell_units, short_return_units, short_balance_units, short_balance_change_pct,
      source, lineage_json, as_of_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, market_segment) DO UPDATE SET
      advance_count=COALESCE(excluded.advance_count, canonical_market_summary_daily.advance_count),
      unchanged_count=COALESCE(excluded.unchanged_count, canonical_market_summary_daily.unchanged_count),
      decline_count=COALESCE(excluded.decline_count, canonical_market_summary_daily.decline_count),
      total_volume=COALESCE(excluded.total_volume, canonical_market_summary_daily.total_volume),
      total_value=COALESCE(excluded.total_value, canonical_market_summary_daily.total_value),
      margin_buy_units=COALESCE(excluded.margin_buy_units, canonical_market_summary_daily.margin_buy_units),
      margin_sell_units=COALESCE(excluded.margin_sell_units, canonical_market_summary_daily.margin_sell_units),
      margin_return_units=COALESCE(excluded.margin_return_units, canonical_market_summary_daily.margin_return_units),
      margin_balance_units=COALESCE(excluded.margin_balance_units, canonical_market_summary_daily.margin_balance_units),
      margin_buy_value=COALESCE(excluded.margin_buy_value, canonical_market_summary_daily.margin_buy_value),
      margin_sell_value=COALESCE(excluded.margin_sell_value, canonical_market_summary_daily.margin_sell_value),
      margin_return_value=COALESCE(excluded.margin_return_value, canonical_market_summary_daily.margin_return_value),
      margin_balance_value=COALESCE(excluded.margin_balance_value, canonical_market_summary_daily.margin_balance_value),
      margin_balance_change_pct=COALESCE(excluded.margin_balance_change_pct, canonical_market_summary_daily.margin_balance_change_pct),
      short_buy_units=COALESCE(excluded.short_buy_units, canonical_market_summary_daily.short_buy_units),
      short_sell_units=COALESCE(excluded.short_sell_units, canonical_market_summary_daily.short_sell_units),
      short_return_units=COALESCE(excluded.short_return_units, canonical_market_summary_daily.short_return_units),
      short_balance_units=COALESCE(excluded.short_balance_units, canonical_market_summary_daily.short_balance_units),
      short_balance_change_pct=COALESCE(excluded.short_balance_change_pct, canonical_market_summary_daily.short_balance_change_pct),
      source=CASE
        WHEN INSTR(canonical_market_summary_daily.source, excluded.source) > 0 THEN canonical_market_summary_daily.source
        ELSE canonical_market_summary_daily.source || ';' || excluded.source
      END,
      lineage_json=excluded.lineage_json,
      as_of_date=excluded.as_of_date
  `).bind(
    row.date,
    row.market_segment,
    row.advance_count ?? null,
    row.unchanged_count ?? null,
    row.decline_count ?? null,
    row.total_volume ?? null,
    row.total_value ?? null,
    row.margin_buy_units ?? null,
    row.margin_sell_units ?? null,
    row.margin_return_units ?? null,
    row.margin_balance_units ?? null,
    row.margin_buy_value ?? null,
    row.margin_sell_value ?? null,
    row.margin_return_value ?? null,
    row.margin_balance_value ?? null,
    row.margin_balance_change_pct ?? null,
    row.short_buy_units ?? null,
    row.short_sell_units ?? null,
    row.short_return_units ?? null,
    row.short_balance_units ?? null,
    row.short_balance_change_pct ?? null,
    row.source,
    row.lineage_json,
    row.as_of_date,
  ))
  if (statements.length) await db.batch(statements)
}

export async function runOfficialMarketSummaryRefresh(env: Bindings, targetDate: string): Promise<string> {
  const generatedAt = new Date().toISOString()
  const runId = `official-market-summary-${targetDate.replace(/-/g, '')}-${Date.now()}`
  const rows = await deriveOtcSummaryFromCanonicalChip(
    env.DB,
    await fetchOfficialMarketSummaryRows(targetDate, runId, generatedAt),
    targetDate,
    runId,
    generatedAt,
  )
  validateTargetDateRows(rows, targetDate)
  await upsertMarketSummaryRows(env.DB, rows)
  const summary = rows.map((row) => `${row.market_segment}:${row.date}:${row.source}`).join(',')
  return `official market summary refreshed for ${targetDate}: rows=${rows.length} ${summary}`
}
