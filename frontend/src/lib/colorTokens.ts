/**
 * Canvas／SVG 圖表用的色票（Tailwind class 用 text-up／bg-ok 等，值在 index.css :root）。
 * 價格與報酬：UP 紅、DOWN 綠（台股慣例），搭配 ▲▼。
 * 狀態：OK 藍、WARN 琥珀、FAIL 洋紅、NA slate（尚未檢查），搭配圖示。
 */
export const TW_COLORS = {
  up: '#ff4d4f',
  down: '#22c55e',
  ok: '#5b9bff',
  warn: '#f5a524',
  fail: '#f05bb0',
  na: '#2c303c',
  neutral: '#8992a3',
} as const

export type PriceDirection = 'up' | 'down' | 'flat'

export function priceDirection(value: number | null | undefined): PriceDirection {
  if (value == null || !Number.isFinite(value) || value === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

/** 正數紅、負數綠、零與缺值中性。只給價格、報酬、買賣超、口數。 */
export function priceToneClass(value: number | null | undefined): string {
  const d = priceDirection(value)
  return d === 'up' ? 'text-up' : d === 'down' ? 'text-down' : 'text-muted-foreground'
}

export function priceColor(value: number | null | undefined): string {
  const d = priceDirection(value)
  return d === 'up' ? TW_COLORS.up : d === 'down' ? TW_COLORS.down : TW_COLORS.neutral
}

export function priceArrow(value: number | null | undefined): string {
  const d = priceDirection(value)
  return d === 'up' ? '▲' : d === 'down' ? '▼' : ''
}

export type StatusTone = 'ok' | 'warn' | 'fail' | 'na'

export const STATUS_TEXT: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  fail: 'text-fail',
  na: 'text-muted-foreground',
}

export const STATUS_CHIP: Record<StatusTone, string> = {
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  fail: 'border-fail/35 bg-fail/10 text-fail',
  na: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
}
