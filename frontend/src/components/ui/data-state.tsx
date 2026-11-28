import { StatusIcon } from './status'

/**
 * 空資料／載入中／失敗的固定樣式（2026-11-26）。
 * - 一行人話（title），可選一行補充（hint）。
 * - 後端原始代碼只能放 code：只寫進 data-code 屬性（開發者工具可查），畫面與 tooltip 都不顯示（Wei 規則：title 不露原碼）。
 * - title 與 hint 各自是獨立區塊（flex-wrap），窄欄換行時不會疊在一起。
 * - onRetry 存在才顯示「重試」。
 * - 失敗時保留上次資料的情境請用 kind="stale"。
 */
export type DataStateKind = 'loading' | 'empty' | 'error' | 'stale'

export function DataState({
  kind,
  title,
  hint,
  code,
  onRetry,
  minHeight,
  className = '',
}: {
  kind: DataStateKind
  title?: string
  hint?: string
  code?: string | null
  onRetry?: () => void
  minHeight?: number
  className?: string
}) {
  const text = title ?? DEFAULT_TITLE[kind]
  if (kind === 'loading') {
    return (
      <div role="status" aria-live="polite" className={`flex flex-col justify-center gap-1.5 px-3 py-3 ${className}`} style={minHeight ? { minHeight } : undefined}>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-ok/70" />{text}
        </div>
        <div className="h-2 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    )
  }
  const tone = kind === 'error' ? 'fail' : kind === 'stale' ? 'warn' : 'na'
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      data-code={code ?? undefined}
      data-state={kind}
      className={`flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground ${className}`}
      style={minHeight ? { minHeight } : undefined}
    >
      <StatusIcon tone={tone} size={12} />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={kind === 'error' ? 'text-foreground' : ''}>{text}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-muted">
          重試
        </button>
      )}
    </div>
  )
}

const DEFAULT_TITLE: Record<DataStateKind, string> = {
  loading: '載入中',
  empty: '目前沒有資料',
  error: '資料暫時讀不到',
  stale: '更新失敗，顯示上次資料',
}
