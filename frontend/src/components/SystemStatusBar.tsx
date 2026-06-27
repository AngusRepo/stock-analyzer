import { useQuery } from '@tanstack/react-query'
import { systemApi } from '@/lib/api'
import { formatTwDateKey, formatTwDateShort, formatTwTime } from '@/lib/twTime'

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '無資料'
  const dateKey = formatTwDateKey(dateStr)
  const todayKey = formatTwDateKey(new Date().toISOString())
  const yesterdayKey = formatTwDateKey(new Date(Date.now() - 86400000).toISOString())

  if (dateKey && dateKey === todayKey) return `今日 ${formatTwTime(dateStr)}`
  if (dateKey && dateKey === yesterdayKey) return '昨日'
  return formatTwDateShort(dateStr)
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
      ok ? 'bg-emerald-400' : warn ? 'animate-pulse bg-yellow-400' : 'animate-pulse bg-red-400'
    }`} />
  )
}

interface Props {
  mode?: 'compact' | 'full'
}

export default function SystemStatusBar({ mode = 'compact' }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'status'],
    queryFn: systemApi.status,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 3 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-[10px] text-muted-foreground/50">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/30" />
        <span>載入資料狀態...</span>
      </div>
    )
  }

  if (!data) return null

  const { overall, data: d } = data
  const isOk = overall === 'ok'
  const isWarn = overall === 'warning'

  if (mode === 'compact') {
    return (
      <div className="group relative">
        <div className="flex cursor-default items-center gap-1.5 px-3 py-2 text-[10px] text-muted-foreground">
          <Dot ok={isOk} warn={isWarn} />
          <span>
            {isOk
              ? `資料正常 ${formatDate(d.prices.lastDate)}`
              : isWarn
                ? '部分資料需確認'
                : '資料異常'}
          </span>
        </div>

        <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1 w-56 rounded-lg border border-border bg-popover p-3 opacity-0 shadow-lg transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
          <p className="mb-2 text-[10px] font-semibold normal-case text-muted-foreground">
            資料健康度
          </p>
          <div className="space-y-1.5">
            <Row label="價格 / 指標" date={d.prices.lastDate} ok={d.prices.isRecent} />
            <Row label="籌碼資料" date={d.chips.lastDate} ok={d.chips.isRecent} />
            <Row label="新聞事件" date={d.news.lastDate} ok={d.news.isRecent} />
            <Row label="ML 預測" date={d.predictions.lastDate} ok={d.predictions.isRecent} />
            <Row label="市場風險" date={d.marketRisk.lastDate} ok={d.marketRisk.isRecent} />
          </div>
          <div className="mt-2 flex justify-between border-t border-border pt-2 text-[9px] text-muted-foreground">
            <span>股票 {data.meta.activeStocks}</span>
            {data.meta.dbSizeBytes && (
              <span>DB {(data.meta.dbSizeBytes / 1024 / 1024).toFixed(1)} MB</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4">
      <p className="text-xs font-semibold normal-case text-muted-foreground">資料健康度</p>
      <Row label="價格 / 指標" date={d.prices.lastDate} ok={d.prices.isRecent} />
      <Row label="籌碼資料" date={d.chips.lastDate} ok={d.chips.isRecent} />
      <Row label="新聞事件" date={d.news.lastDate} ok={d.news.isRecent} />
      <Row label="ML 預測" date={d.predictions.lastDate} ok={d.predictions.isRecent} />
      <Row label="市場風險" date={d.marketRisk.lastDate} ok={d.marketRisk.isRecent} />
    </div>
  )
}

function Row({ label, date, ok }: { label: string; date: string | null; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5">
        <Dot ok={ok} />
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
      <span className={`sv-num text-[11px] tabular-nums ${ok ? 'text-foreground' : 'text-yellow-400'}`}>
        {formatDate(date)}
      </span>
    </div>
  )
}
