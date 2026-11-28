import type { ReactNode } from 'react'
import { STATUS_CHIP, STATUS_TEXT, priceArrow, priceToneClass, type StatusTone } from '@/lib/colorTokens'
import { formatSignedPct } from '@/lib/format'

/**
 * 狀態一律「形狀＋顏色」：去掉顏色也讀得懂。
 * ok＝實心圓勾、warn＝三角驚嘆、fail＝菱形叉、na＝空心圓（尚未檢查）。
 */
export function StatusIcon({ tone, size = 12, title }: { tone: StatusTone; size?: number; title?: string }) {
  const c = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'fail' ? 'var(--fail)' : '#64748b'
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-label={title ?? STATUS_LABEL[tone]} role="img" className="inline-block shrink-0 align-[-1px]">
      {title && <title>{title}</title>}
      {tone === 'ok' && <><circle cx="6" cy="6" r="5.5" fill={c} /><path d="M3.4 6.2 5.2 8 8.7 4.3" stroke="#0b0d12" strokeWidth="1.6" fill="none" /></>}
      {tone === 'warn' && <><path d="M6 .8 11.4 10.6H.6z" fill={c} /><path d="M6 4.3v3M6 8.6v.4" stroke="#0b0d12" strokeWidth="1.4" /></>}
      {tone === 'fail' && <><path d="M6 .4 11.6 6 6 11.6.4 6z" fill={c} /><path d="m4.2 4.2 3.6 3.6m0-3.6L4.2 7.8" stroke="#0b0d12" strokeWidth="1.4" /></>}
      {tone === 'na' && <circle cx="6" cy="6" r="4.75" fill="none" stroke={c} strokeWidth="1.5" />}
    </svg>
  )
}

export const STATUS_LABEL: Record<StatusTone, string> = { ok: '通過', warn: '注意', fail: '未通過', na: '尚未檢查' }

/** 小型狀態徽章：圖示＋短字；細節放 title（tooltip）。 */
export function StatusBadge({ tone, children, title, className = '' }: { tone: StatusTone; children: ReactNode; title?: string; className?: string }) {
  return (
    // 呼叫端給 whitespace-* 時不再疊 whitespace-nowrap（兩個 class 同時存在時 Tailwind 產生順序決定勝負，長原因文字會撐出右緣）。
    <span title={title} className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-4 ${className.includes('whitespace-') ? '' : 'whitespace-nowrap'} ${STATUS_CHIP[tone]} ${className}`}>
      <StatusIcon tone={tone} size={10} />
      {children}
    </span>
  )
}

export function StatusText({ tone, children, title, className = '' }: { tone: StatusTone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 ${STATUS_TEXT[tone]} ${className}`}>
      <StatusIcon tone={tone} size={10} />
      {children}
    </span>
  )
}

/** 漲跌：紅漲綠跌＋▲▼；value 為百分比數字。 */
export function PriceChange({ value, digits = 2, className = '', children }: { value: number | null | undefined; digits?: number; className?: string; children?: ReactNode }) {
  return (
    <span className={`whitespace-nowrap tabular-nums ${priceToneClass(value)} ${className}`}>
      {priceArrow(value)}{priceArrow(value) ? ' ' : ''}{children ?? formatSignedPct(value, digits)}
    </span>
  )
}
