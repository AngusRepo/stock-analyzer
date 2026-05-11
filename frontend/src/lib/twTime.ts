const TW_TIME_ZONE = 'Asia/Taipei'

function hasExplicitTimeZone(value: string): boolean {
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(value)
}

export function parseBackendTimestamp(value?: string | null): Date | null {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null

  let candidate = raw
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    candidate = `${raw.replace(' ', 'T')}Z`
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !hasExplicitTimeZone(raw)) {
    candidate = `${raw}Z`
  }

  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

export function formatTwDateTimeShort(value?: string | null, fallback = '-'): string {
  const parsed = parseBackendTimestamp(value)
  if (!parsed) return fallback
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TW_TIME_ZONE,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed)
}

export function formatTwTime(value?: string | null, fallback = '-'): string {
  const parsed = parseBackendTimestamp(value)
  if (!parsed) return fallback
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TW_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed)
}

export function formatTwDateKey(value?: string | null): string | null {
  const parsed = parseBackendTimestamp(value)
  if (!parsed) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed)
  const get = (type: string) => parts.find((part) => part.type === type)?.value
  const year = get('year')
  const month = get('month')
  const day = get('day')
  return year && month && day ? `${year}-${month}-${day}` : null
}

export function formatTwDateShort(value?: string | null, fallback = '-'): string {
  const parsed = parseBackendTimestamp(value)
  if (!parsed) return fallback
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TW_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
  }).format(parsed)
}
