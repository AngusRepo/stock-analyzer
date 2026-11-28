// TWSE official JSON cells: thousands-separated numbers and ROC dates (115/11/25 = 2026-11-25).
// Kept free of fetch/clock so the native paper bundle can import it.
export function parseTwseOfficialNumber(value: unknown): number | null {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

export function parseTwseOfficialDate(value: unknown): string | null {
  const match = String(value ?? '').trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/)
  if (!match) return null
  const year = Number(match[1]) + 1911
  return `${year}-${match[2]}-${match[3]}`
}
