/**
 * SystemStatusBar — 資料更新狀態列
 * 顯示各資料來源的最新更新時間，讓用戶知道排程是否成功執行
 */
import { useQuery } from '@tanstack/react-query'
import { systemApi } from '@/lib/api'

// 日期格式化：今天顯示時間，其他顯示日期
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '尚無資料'
  const d = new Date(dateStr)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const isYesterday = new Date(today.getTime() - 86400000).toDateString() === d.toDateString()

  if (isToday)     return `今日 ${d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`
  if (isYesterday) return '昨日'
  return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
}

// 狀態指示燈
function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
      ok ? 'bg-emerald-400' : warn ? 'bg-yellow-400 animate-pulse' : 'bg-red-400 animate-pulse'
    }`} />
  )
}

interface Props {
  // compact 模式：側邊欄底部只顯示一個小燈 + 文字
  // full 模式：展開顯示所有細節（用在設定頁或 hover）
  mode?: 'compact' | 'full'
}

export default function SystemStatusBar({ mode = 'compact' }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'status'],
    queryFn: systemApi.status,
    refetchInterval: 5 * 60 * 1000,  // 每 5 分鐘重新查一次
    staleTime: 3 * 60 * 1000,
  })

  if (isLoading) return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50 px-3 py-2">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
      <span>檢查資料狀態...</span>
    </div>
  )

  if (!data) return null

  const { overall, data: d } = data
  const isOk   = overall === 'ok'
  const isWarn = overall === 'warning'

  if (mode === 'compact') {
    return (
      <div className="group relative">
        {/* 一行摘要 */}
        <div className="flex items-center gap-1.5 px-3 py-2 text-[10px] text-muted-foreground cursor-default">
          <Dot ok={isOk} warn={isWarn} />
          <span>
            {isOk
              ? `資料已更新・${formatDate(d.prices.lastDate)}`
              : isWarn
              ? '部分資料待更新'
              : '資料可能過期'}
          </span>
        </div>

        {/* hover 展開詳細 */}
        <div className="absolute bottom-full left-0 w-56 bg-popover border border-border rounded-lg shadow-lg p-3
                        opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto
                        transition-opacity duration-150 z-50 mb-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            資料更新狀態
          </p>
          <div className="space-y-1.5">
            <Row label="股價/技術指標" date={d.prices.lastDate}     ok={d.prices.isRecent} />
            <Row label="籌碼資料"      date={d.chips.lastDate}      ok={d.chips.isRecent} />
            <Row label="新聞情感"      date={d.news.lastDate}       ok={d.news.isRecent} />
            <Row label="ML 預測"       date={d.predictions.lastDate} ok={d.predictions.isRecent} />
            <Row label="大盤風險"      date={d.marketRisk.lastDate} ok={d.marketRisk.isRecent} />
          </div>
          <div className="mt-2 pt-2 border-t border-border/50 flex justify-between text-[9px] text-muted-foreground">
            <span>監控 {data.meta.activeStocks} 支股票</span>
            {data.meta.dbSizeBytes && (
              <span>DB {(data.meta.dbSizeBytes / 1024 / 1024).toFixed(1)} MB</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  // full mode
  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-4 space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">資料更新狀態</p>
      <Row label="股價/技術指標" date={d.prices.lastDate}      ok={d.prices.isRecent} />
      <Row label="籌碼資料"      date={d.chips.lastDate}       ok={d.chips.isRecent} />
      <Row label="新聞情感"      date={d.news.lastDate}        ok={d.news.isRecent} />
      <Row label="ML 預測"       date={d.predictions.lastDate} ok={d.predictions.isRecent} />
      <Row label="大盤風險"      date={d.marketRisk.lastDate}  ok={d.marketRisk.isRecent} />
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
      <span className={`text-[11px] font-mono tabular-nums ${ok ? 'text-foreground' : 'text-yellow-400'}`}>
        {formatDate(date)}
      </span>
    </div>
  )
}
