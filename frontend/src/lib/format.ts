/**
 * 全站共用數字／日期格式（2026-11-26 前端審查第三批）。
 * - 價格：< 1,000 兩位小數；≥ 1,000 整數時不帶小數，否則兩位。千分位一律有。
 * - 張數／股數：整數千分位。
 * - 金額：$ 前綴千分位；大額可用 formatTwdCompact（萬／億，單位與數字不斷行）。
 * - 百分比：帶正負號，預設兩位。
 * - 日期：YYYY-MM-DD；時間 HH:mm（台北時間）。短日期 MM-DD。分隔符只用「-」。
 */
const TW_TIME_ZONE = 'Asia/Taipei'
const NBSP = ' '

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function formatNumber(value: number | null | undefined, digits = 0, fallback = '—'): string {
  if (!finite(value)) return fallback
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function formatPrice(value: number | null | undefined, fallback = '—'): string {
  if (!finite(value)) return fallback
  if (Math.abs(value) >= 1000 && Number.isInteger(value)) return formatNumber(value, 0)
  return formatNumber(value, 2)
}

export function formatTwd(value: number | null | undefined, fallback = '—'): string {
  if (!finite(value)) return fallback
  const sign = value < 0 ? '-' : ''
  return `${sign}$${formatNumber(Math.abs(value), 0)}`
}

export function formatSignedTwd(value: number | null | undefined, fallback = '—'): string {
  if (!finite(value)) return fallback
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}$${formatNumber(Math.abs(value), 0)}`
}

/** 大額：≥ 1 億用「億」，≥ 1 萬用「萬」；數字與單位以不斷行空白相連。 */
export function formatTwdCompact(value: number | null | undefined, fallback = '—'): string {
  if (!finite(value)) return fallback
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1e8) return `${sign}${formatNumber(abs / 1e8, 2)}${NBSP}億`
  if (abs >= 1e4) return `${sign}${formatNumber(abs / 1e4, abs >= 1e6 ? 0 : 1)}${NBSP}萬`
  return `${sign}${formatNumber(abs, 0)}`
}

/** value 為百分比數字（1.27 代表 1.27%）。 */
export function formatSignedPct(value: number | null | undefined, digits = 2, fallback = '—'): string {
  if (!finite(value)) return fallback
  return `${value > 0 ? '+' : ''}${formatNumber(value, digits)}%`
}

/** ratio 為比例（0.0127 代表 1.27%）。 */
export function formatSignedRatio(ratio: number | null | undefined, digits = 2, fallback = '—'): string {
  return finite(ratio) ? formatSignedPct(ratio * 100, digits, fallback) : fallback
}

export function formatPct(value: number | null | undefined, digits = 1, fallback = '—'): string {
  if (!finite(value)) return fallback
  return `${formatNumber(value, digits)}%`
}

export function formatShares(shares: number | null | undefined, fallback = '—'): string {
  if (!finite(shares)) return fallback
  return `${formatNumber(shares, 0)}${NBSP}股`
}

function parseInstant(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null
  const raw = value.trim()
  // Date-only strings are calendar dates, not instants.
  if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(raw)) return new Date(`${raw.replace(/\//g, '-')}T00:00:00+08:00`)
  let candidate = raw
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) candidate = `${raw.replace(' ', 'T')}Z`
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/(?:z|[+-]\d{2}:?\d{2})$/i.test(raw)) candidate = `${raw}Z`
  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function twParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TW_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date)
  const out: Record<string, string> = {}
  for (const part of parts) out[part.type] = part.value
  if (out.hour === '24') out.hour = '00'
  return out
}

/** YYYY-MM-DD（台北日曆日）。 */
export function formatDate(value: string | number | Date | null | undefined, fallback = '—'): string {
  if (typeof value === 'string' && /^\d{4}[-/]\d{2}[-/]\d{2}/.test(value.trim()) && !/[T\s]\d{2}:/.test(value)) {
    return value.trim().slice(0, 10).replace(/\//g, '-')
  }
  const date = parseInstant(value)
  if (!date) return fallback
  const p = twParts(date)
  return `${p.year}-${p.month}-${p.day}`
}

/** MM-DD（同年內的短日期）。 */
export function formatDateShort(value: string | number | Date | null | undefined, fallback = '—'): string {
  const full = formatDate(value, '')
  return full ? full.slice(5) : fallback
}

/** HH:mm（台北時間）。 */
export function formatTime(value: string | number | Date | null | undefined, fallback = '—', seconds = false): string {
  const date = parseInstant(value)
  if (!date) return fallback
  const p = twParts(date)
  return seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`
}

/** MM-DD HH:mm（台北時間）。 */
export function formatDateTimeShort(value: string | number | Date | null | undefined, fallback = '—'): string {
  const date = parseInstant(value)
  if (!date) return fallback
  const p = twParts(date)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** YYYY-MM-DD HH:mm（台北時間）。 */
export function formatDateTime(value: string | number | Date | null | undefined, fallback = '—'): string {
  const date = parseInstant(value)
  if (!date) return fallback
  const p = twParts(date)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}
