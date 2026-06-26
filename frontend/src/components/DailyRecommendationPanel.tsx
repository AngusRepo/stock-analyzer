/**
 * DailyRecommendationPanel.tsx
 * 每日選股推薦面板 — 顯示 ML + 籌碼 + LLM 綜合推薦結果
 */
import { useQuery } from '@tanstack/react-query'
import { recommendationsApi } from '@/lib/api'
import {
  BarChart3, RefreshCw, Star,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Treemap, ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } from 'recharts'
import { paperApi } from '@/lib/api'
import { AI_TOP_PICK_EXPLANATION, RecommendationCardClean } from '@/components/RecommendationCardClean'
import { splitRecommendationLanes } from '@/lib/recommendationLanes'
import { formatTwDateTimeShort } from '@/lib/twTime'

/** 法人金額格式化：< 0.01億 改顯示萬元 */
function fmtChipAmount(billion: number | null | undefined): string {
  if (billion == null) return '-'
  const abs = Math.abs(billion)
  if (abs < 0.01 && abs > 0) {
    const wan = Math.round(billion * 10000)  // 億 → 萬
    return `${wan > 0 ? '+' : ''}${wan}萬`
  }
  return `${billion > 0 ? '+' : ''}${billion.toFixed(2)}億`
}

// ─── Sector flow bar ───────────────────────────────────────────────────────
/** 法人淨額 heatmap 背景色 — 正買超綠、負賣超紅，越大越深 */
function chipHeatBg(net: number, maxAbs: number): string {
  if (maxAbs <= 0) return ''
  const intensity = Math.min(1, Math.abs(net) / maxAbs)
  const alpha = (intensity * 0.35).toFixed(2)
  return net >= 0 ? `rgba(16,185,129,${alpha})` : `rgba(239,68,68,${alpha})`
}

// ─── Sector flow bar（Diverging bar：中央 0 軸，買超向右/賣超向左）─────────
function SectorFlowBar({ flow, maxAbs }: { flow: any; maxAbs: number }) {
  const net = flow.total_net ?? 0
  const pct = maxAbs > 0 ? Math.abs(net) / maxAbs * 50 : 0 // 50% = 半邊最大
  const positive = net >= 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 truncate text-muted-foreground shrink-0" title={flow.sector}>{flow.sector}</span>
      <div className="flex-1 flex items-center h-4">
        {/* 左半：賣超（綠色，從中間向左長） */}
        <div className="w-1/2 flex justify-end">
          {!positive && (
            <div className="bg-emerald-400/70 h-3 rounded-sm" style={{ width: `${pct}%` }} />
          )}
        </div>
        {/* 中線 */}
        <div className="w-px h-4 bg-border shrink-0" />
        {/* 右半：買超（紅色，從中間向右長） */}
        <div className="w-1/2">
          {positive && (
            <div className="bg-red-500/80 h-3 rounded-sm" style={{ width: `${pct}%` }} />
          )}
        </div>
      </div>
      <span className={cn('w-16 text-right font-mono', positive ? 'text-red-400' : 'text-emerald-400')}>
        {fmtChipAmount(net)}
      </span>
    </div>
  )
}

// ─── Main panel ────────────────────────────────────────────────────────────
function SectorFlowStaleNotice({ data, label = 'theme flow' }: { data: any; label?: string }) {
  if (!data) return null
  const actualDate = data.stale ? data.stale_date : data.date
  const requestedDate = data.requested_date ?? data.date
  const updatedAt = data.flows?.[0]?.created_at ?? data.stocks?.[0]?.created_at
  return (
    <div className={cn(
      'mb-3 rounded-2xl border px-3 py-2 text-[11px] leading-relaxed',
      data.stale
        ? 'border-[#d6a85f]/30 bg-[#d6a85f]/10 text-[#f1c16f]'
        : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200',
    )}>
      <span className="font-medium">{label}</span>
      <span className="ml-2">
        資料日 {actualDate ?? '-'}；請求日 {requestedDate ?? '-'}
        {updatedAt ? `；更新 ${formatTwDateTimeShort(updatedAt)}` : ''}
        {data.stale ? '，目前使用最近可用資料，請檢查 sector_flow 是否完成更新。' : '，已對齊目前查詢日期。'}
      </span>
    </div>
  )
}

export function DailyRecommendationPanel() {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date

  const { data: recData, isLoading: recLoading, refetch } = useQuery({
    queryKey: ['recommendations', 'daily', today],
    queryFn:  () => recommendationsApi.daily(),
    staleTime: 30 * 60 * 1000,
  })

  const { tradable: tradableRecs } = splitRecommendationLanes<any>(recData)
  const recs = tradableRecs

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between rounded-2xl border border-[#3a3125] bg-[#171714]/70 p-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2 text-[#fff7e8]">
            <Star className="w-4 h-4 text-[#d6a85f]" />
            今日候選清單
          </h2>
          <p className="text-xs text-[#8f877a] mt-0.5">
            {recData?.date ?? today} · 模型、籌碼與理由整理
          </p>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-[#b9b1a1]">
            {AI_TOP_PICK_EXPLANATION}
          </p>
        </div>
        <Button
          variant="ghost" size="sm"
          onClick={() => refetch()}
          className="text-xs gap-1.5 rounded-full text-[#f1c16f] hover:bg-[#d6a85f]/10"
          disabled={recLoading}
        >
          <RefreshCw className={cn('w-3.5 h-3.5', recLoading && 'animate-spin')} />
          更新
        </Button>
      </div>

      {/* ── Recommendations ── */}
      {recLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 rounded-xl bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : recs.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <Star className="w-8 h-8 mx-auto mb-2 opacity-20" />
          <p className="text-sm">今日推薦尚未產生</p>
          <p className="text-xs mt-1">每日 15:35 自動更新</p>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <div>
                <p className="text-xs font-semibold text-[#9fcca1]">上市櫃交易候選</p>
                <p className="text-[11px] text-[#8f877a]">會進入 morning setup / debate / pending buys 的主流程。</p>
              </div>
              <Badge variant="outline" className="text-[10px] rounded-full border-[#9fcca1]/30 text-[#cbe4c7]">
                {tradableRecs.length} 檔
              </Badge>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {tradableRecs.map((rec: any, i: number) => (
                <RecommendationCardClean key={rec.stock_id ?? i} rec={rec} rank={i + 1} />
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ─── Quadrant badge ──────────────────────────────────────────────────────
const QUADRANT_STYLE: Record<string, { label: string; cls: string }> = {
  Leading:   { label: 'Leading',   cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  Improving: { label: 'Improving', cls: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  Weakening: { label: 'Weakening', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  Lagging:   { label: 'Lagging',   cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
}

// ─── Treemap 自訂內容 ────────────────────────────────────────────────────────
function TreemapContent(props: any) {
  const { x, y, width, height, name, net } = props
  if (width < 40 || height < 20 || net == null) return null
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={3}
        fill={net >= 0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.5)'}
        stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
      <text x={x + width / 2} y={y + height / 2 - 4} textAnchor="middle"
        fill="white" fontSize={width < 60 ? 9 : 11} fontWeight={600}>
        {name}
      </text>
      <text x={x + width / 2} y={y + height / 2 + 10} textAnchor="middle"
        fill="rgba(255,255,255,0.7)" fontSize={9}>
        {Math.abs(net) < 0.05 ? `${Math.round(net * 10000)}萬` : `${net > 0 ? '+' : ''}${net.toFixed(1)}億`}
      </text>
    </g>
  )
}

// ─── Theme Ranking Table（族群層級，無個股金額）───────────────────────────────
// ─── Word Cloud（漂浮動畫）────────────────────────────────────────────────────
function WordCloud({ items, type }: { items: { text: string; value: number; positive: boolean }[]; type: 'concept' | 'stock' }) {
  if (!items.length) return null
  const maxVal = Math.max(...items.map(i => Math.abs(i.value)), 1)

  // 穩定的偽隨機（基於文字 hash），不用 Math.random 避免 re-render 跳動
  const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h) }

  // 用圓形散佈演算法計算初始位置（非長方形）
  const positions = items.map((item, i) => {
    const h = hash(item.text)
    const angle = (i / items.length) * Math.PI * 2 + (h % 100) * 0.01
    const radius = 25 + (h % 20) // 25-45% from center
    const x = 50 + Math.cos(angle) * radius
    const y = 50 + Math.sin(angle) * radius
    return { x: Math.max(8, Math.min(92, x)), y: Math.max(10, Math.min(90, y)) }
  })

  const ANIMS = ['wc-float-1', 'wc-float-2', 'wc-float-3']

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">{type === 'concept' ? '概念熱度' : '個股關注度'}</p>
      <div className="relative w-full overflow-hidden" style={{ height: items.length > 8 ? 160 : 120 }}>
        {items.map((item, i) => {
          const ratio = Math.abs(item.value) / maxVal
          const fontSize = Math.max(10, Math.min(26, 10 + ratio * 16))
          const opacity = 0.45 + ratio * 0.55
          const h = hash(item.text)
          const anim = ANIMS[h % 3]
          const duration = 6 + (h % 8) * 1.5 // 6-18s (faster drift)
          const delay = -(h % 8) * 1.2 // staggered start
          const dx = 8 + (h % 10) // drift amplitude 8-17px (wider)
          const dy = 5 + (h % 8) // drift amplitude 5-12px (wider)
          const rot = ((h % 7) - 3) // -3 ~ +3 deg
          const { x, y } = positions[i]

          return (
            <span
              key={item.text}
              className={cn(
                'absolute cursor-default hover:scale-125 hover:!opacity-100 transition-[transform,opacity] duration-200',
                item.positive ? 'text-red-400' : 'text-emerald-400',
              )}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                fontSize: `${fontSize}px`,
                opacity,
                fontWeight: ratio > 0.5 ? 600 : 400,
                animation: `${anim} ${duration}s ease-in-out ${delay}s infinite`,
                '--wc-dx': dx,
                '--wc-dy': dy,
                '--wc-rot': `${rot}deg`,
                willChange: 'transform',
              } as React.CSSProperties}
              title={`${item.text}: ${fmtChipAmount(item.value)}`}
            >
              {item.text}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// 模擬交易室用 — 含象限 + RS（差異化）
function BotThemeRankingTable({ flows, title, color }: { flows: any[]; title: string; color: string }) {
  if (!flows.length) return <p className="text-xs text-muted-foreground">無{title}主題</p>
  const maxAbs = Math.max(...flows.map((f: any) => Math.abs(f.total_net ?? 0)), 0.01)
  return (
    <div>
      <p className={cn('text-xs font-medium mb-1', color)}>{title}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '30%' }} />
            <col style={{ width: '40%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '12%' }} />
          </colgroup>
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left py-1 pl-1 font-medium">概念</th>
              <th className="text-center py-1 font-medium">法人淨額</th>
              <th className="text-center py-1 font-medium">象限</th>
              <th className="text-right py-1 pr-1 font-medium">RS</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((f: any) => {
              const net = f.total_net ?? 0
              const q = QUADRANT_STYLE[f.quadrant] ?? null
              return (
                <tr key={f.sector} className="border-b border-border">
                  <td className="py-1 pl-1 truncate max-w-[6rem]" title={f.sector}>{f.sector}</td>
                  <td className="py-1 px-1">
                    <div className="flex items-center h-3">
                      <div className="w-1/2 flex justify-end">
                        {net < 0 && <div className="bg-emerald-400/70 h-2.5 rounded-sm" style={{ width: `${Math.min(100, Math.abs(net) / maxAbs * 100)}%` }} />}
                      </div>
                      <div className="w-px h-3 bg-border shrink-0" />
                      <div className="w-1/2">
                        {net >= 0 && <div className="bg-red-500/70 h-2.5 rounded-sm" style={{ width: `${Math.min(100, Math.abs(net) / maxAbs * 100)}%` }} />}
                      </div>
                    </div>
                    <div className={cn('text-[10px] font-mono text-center', net >= 0 ? 'text-red-400' : 'text-emerald-400')}>
                      {fmtChipAmount(net)}
                    </div>
                  </td>
                  <td className="text-center py-1">
                    {q ? <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', q.cls)}>{q.label}</Badge> : '-'}
                  </td>
                  <td className="text-right py-1 pr-1 font-mono text-muted-foreground text-[11px]">
                    {f.rs_ratio != null ? Number(f.rs_ratio).toFixed(0) : '-'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Theme Flow Panel（晨間概覽用）— Ranking Table + Treemap ───────────────
export function ThemeFlowPanel() {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  const { data: themeData, isLoading: themeLoading } = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'theme', today],
    queryFn:  () => recommendationsApi.sectorFlow(undefined, 'theme'),
    staleTime: 30 * 60 * 1000,
  })
  const { data: stocksData } = useQuery({
    queryKey: ['recommendations', 'sector-flow-stocks', 'top', today],
    queryFn:  () => recommendationsApi.sectorFlowStocks(undefined, 'top'),
    staleTime: 30 * 60 * 1000,
  })

  const allFlows = themeData?.flows ?? []
  const allStocks = stocksData?.stocks ?? []
  const dataDate = themeData?.stale ? themeData?.stale_date : themeData?.date
  const updatedAt = allFlows[0]?.created_at
  const MIN_NET = 0.1  // 最小成交額 0.1 億（過濾雜訊）
  const topBuy  = allFlows.filter((f: any) => (f.total_net ?? 0) > MIN_NET).slice(0, 10)
  const topSell = allFlows.filter((f: any) => (f.total_net ?? 0) < -MIN_NET).sort((a: any, b: any) => (a.total_net ?? 0) - (b.total_net ?? 0)).slice(0, 10)
  const allShown = [...topBuy, ...topSell]
  const maxAbs = allShown.length ? Math.max(...allShown.map((f: any) => Math.abs(f.total_net ?? 0)), 1) : 1

  // Treemap data — top 15 by |total_net|
  const treemapData = [...allFlows]
    .sort((a: any, b: any) => Math.abs(b.total_net ?? 0) - Math.abs(a.total_net ?? 0))
    .slice(0, 15)
    .map((f: any) => ({
      name: f.sector,
      size: Math.abs(f.total_net ?? 0.01),
      net: f.total_net ?? 0,
    }))

  return (
    <div className="rounded-2xl border border-[#3a3125] bg-[#171714]/80 p-4">
      <SectorFlowStaleNotice data={themeData} label="主題資金流" />
      <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-[#fff7e8]">
        <BarChart3 className="h-4 w-4 text-[#d6a85f]" />
        主題資金流（近 5 個交易日累計，單位：億元）
      </h3>
      <div className="mb-3 rounded-xl border border-[#3a3125] bg-[#0b0d11]/70 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
        <p>
          資料日 {dataDate ?? '-'}{updatedAt ? `；更新 ${formatTwDateTimeShort(updatedAt)}` : ''}。這裡不是單日全市場三大法人總買賣超，而是每個主題成分股近 5 個交易日的外資、投信、自營商股數，乘以收盤價後加總成億元。
        </p>
        <p className="mt-1 text-[#d6a85f]">
          注意：同一檔股票可同時屬於 AI PC、5G、車用電子等多個主題，所以不同主題金額不可相加成全市場總額；若要看單日全市場三大法人，應看 market-wide chip flow。
        </p>
      </div>
      {themeLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-5 rounded bg-muted/40 animate-pulse" />)}
        </div>
      ) : allFlows.length === 0 ? (
        <p className="text-xs text-muted-foreground">尚無主題資料</p>
      ) : (
        <div className="space-y-4">
          {/* 概念 Word Cloud — 字體大小=|法人淨額|，顏色=買超藍/賣超紅 */}
          <WordCloud
            type="concept"
            items={[...allFlows]
              .sort((a: any, b: any) => Math.abs(b.total_net ?? 0) - Math.abs(a.total_net ?? 0))
              .slice(0, 25)
              .map((f: any) => ({ text: f.sector, value: f.total_net ?? 0, positive: (f.total_net ?? 0) >= 0 }))}
          />
          {/* 個股 Word Cloud — 字體大小=|法人淨額|，顏色=買超藍/賣超紅 */}
          {allStocks.length > 0 && (
            <WordCloud
              type="stock"
              items={(() => {
                // 每個概念取 top 1 個股，按 net_amount 排序取前 25
                const seen = new Set<string>()
                const result: { text: string; value: number; positive: boolean }[] = []
                for (const s of [...allStocks].sort((a: any, b: any) => Math.abs(b.net_amount ?? 0) - Math.abs(a.net_amount ?? 0))) {
                  if (seen.has(s.symbol)) continue
                  seen.add(s.symbol)
                  result.push({ text: `${s.name}`, value: s.net_amount ?? 0, positive: (s.net_amount ?? 0) >= 0 })
                  if (result.length >= 30) break
                }
                return result
              })()}
            />
          )}
          {/* Treemap */}
          {treemapData.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-2">法人資金 Treemap</p>
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <Treemap
                    data={treemapData}
                    dataKey="size"
                    aspectRatio={4 / 3}
                    content={<TreemapContent />}
                  />
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {/* Bar chart — 買超 */}
          <div>
            <p className="text-xs text-red-400 font-medium mb-2">近 5 日買超主題 Top 10</p>
            <div className="space-y-1.5">
              {topBuy.length ? topBuy.map((f: any) => (
                <SectorFlowBar key={f.sector} flow={f} maxAbs={maxAbs} />
              )) : <p className="text-xs text-muted-foreground">無買超主題</p>}
            </div>
          </div>
          {/* Bar chart — 賣超 */}
          <div>
            <p className="text-xs text-emerald-400 font-medium mb-2">近 5 日賣超主題 Top 10</p>
            <div className="space-y-1.5">
              {topSell.length ? topSell.map((f: any) => (
                <SectorFlowBar key={f.sector} flow={f} maxAbs={maxAbs} />
              )) : <p className="text-xs text-muted-foreground">無賣超主題</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── RRG Scatter Chart（四象限）───────────────────────────────────────────────
function RRGScatterChart({ flows }: { flows: any[] }) {
  // 只取有 RRG 資料的概念
  const data = flows
    .filter((f: any) => f.rs_ratio != null && f.rs_momentum != null)
    .map((f: any) => ({
      name: f.sector,
      x: f.rs_ratio,
      y: f.rs_momentum,
      z: Math.abs(f.total_net ?? 1),
      quadrant: f.quadrant,
    }))

  if (!data.length) return <p className="text-xs text-muted-foreground">RRG 資料尚未產生（需累積 5+ 交易日）</p>

  const QUADRANT_COLORS: Record<string, string> = {
    Leading: '#10b981', Improving: '#3b82f6', Weakening: '#f59e0b', Lagging: '#ef4444',
  }

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">RRG 四象限圖</p>
      <div className="h-96 min-h-[24rem] w-full overflow-visible pb-2">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 28, right: 28, bottom: 48, left: 28 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis type="number" dataKey="x" name="RS-Ratio" domain={['auto', 'auto']}
              tick={{ fontSize: 12, fill: '#999' }} label={{ value: 'RS-Ratio', position: 'bottom', fontSize: 12, fill: '#888' }} />
            <YAxis type="number" dataKey="y" name="RS-Momentum" domain={['auto', 'auto']}
              tick={{ fontSize: 12, fill: '#999' }} label={{ value: 'Momentum', angle: -90, position: 'insideLeft', fontSize: 12, fill: '#888' }} />
            <ZAxis type="number" dataKey="z" range={[40, 300]} />
            <ReferenceLine x={100} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
            <Tooltip
              content={({ payload }) => {
                if (!payload?.length) return null
                const d = payload[0].payload
                return (
                  <div className="bg-card border border-border rounded px-2 py-1 text-xs">
                    <p className="font-medium">{d.name}</p>
                    <p className="text-muted-foreground">RS: {d.x?.toFixed(1)} | Mom: {d.y?.toFixed(1)}</p>
                    <p style={{ color: QUADRANT_COLORS[d.quadrant] }}>{d.quadrant}</p>
                  </div>
                )
              }}
            />
            <Scatter
              data={data}
              label={({ x, y, value, index }: any) => {
                const d = data[index]
                if (!d) return null
                return (
                  <text x={x} y={y - 10} textAnchor="middle" fontSize={10} fontWeight={500}
                    fill={QUADRANT_COLORS[d.quadrant] ?? '#888'} opacity={0.9}>
                    {d.name}
                  </text>
                )
              }}
            >
              {data.map((d, i) => (
                <Cell key={i} fill={QUADRANT_COLORS[d.quadrant] ?? '#888'} fillOpacity={0.8} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {/* Quadrant legend */}
      <div className="flex justify-center gap-4 mt-1">
        {Object.entries(QUADRANT_COLORS).map(([q, c]) => (
          <span key={q} className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c }} />
            {q}
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── T2 Quadrant Filter Log ─────────────────────────────────────────────────
function QuadrantFilterLog() {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const { data } = useQuery({
    queryKey: ['paper', 'quadrant-filter', today],
    queryFn:  () => paperApi.quadrantFilter(today),
    staleTime: 30 * 60 * 1000,
  })

  const log = data?.log ?? []
  if (!log.length) return null

  const ACTION_STYLE: Record<string, string> = {
    REJECT: 'text-red-400',
    DOWNGRADE: 'text-amber-400',
    PASS: 'text-emerald-400',
  }

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">T2 精篩紀錄（{data?.date ?? today}）</p>
      <div className="space-y-1">
        {log.map((entry: any, i: number) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-16 font-mono">{entry.symbol}</span>
            <span className="text-muted-foreground truncate flex-1">{entry.name}</span>
            <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0',
              QUADRANT_STYLE[entry.quadrant]?.cls ?? '')}>
              {entry.quadrant}
            </Badge>
            {entry.momentum_dir && (
              <span className={cn('text-[10px]', entry.momentum_dir === 'up' ? 'text-red-400' : 'text-emerald-400')}>
                {entry.momentum_dir === 'up' ? '▲' : '▼'}
              </span>
            )}
            <span className={cn('font-medium text-[10px] w-16 text-right', ACTION_STYLE[entry.action] ?? '')}>
              {entry.action}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Bot Theme Flow Panel（RRG + 過濾紀錄 + Ranking Table + Treemap）─────────
export function BotThemeFlowPanel() {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  const { data: themeData, isLoading } = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'theme', today],
    queryFn:  () => recommendationsApi.sectorFlow(undefined, 'theme'),
    staleTime: 30 * 60 * 1000,
  })

  const allFlows = themeData?.flows ?? []
  const MIN_NET = 0.1  // 最小成交額 0.1 億（過濾雜訊）
  const topBuy  = allFlows.filter((f: any) => (f.total_net ?? 0) > MIN_NET).slice(0, 10)
  const topSell = allFlows.filter((f: any) => (f.total_net ?? 0) < -MIN_NET).sort((a: any, b: any) => (a.total_net ?? 0) - (b.total_net ?? 0)).slice(0, 10)

  // Treemap data
  const treemapData = [...allFlows]
    .sort((a: any, b: any) => Math.abs(b.total_net ?? 0) - Math.abs(a.total_net ?? 0))
    .slice(0, 15)
    .map((f: any) => ({
      name: f.sector,
      size: Math.abs(f.total_net ?? 0.01),
      net: f.total_net ?? 0,
    }))

  return (
    <div className="rounded-2xl border border-[#3a3125] bg-[#171714]/80 p-4">
      <h3 className="text-sm font-medium mb-3 flex items-center gap-2 text-[#fff7e8]">
        <BarChart3 className="w-4 h-4 text-[#d6a85f]" />
        主題輪動 + RRG 四象限
      </h3>
      <SectorFlowStaleNotice data={themeData} label="Bot 主題資金流" />
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-5 rounded bg-muted/40 animate-pulse" />)}
        </div>
      ) : allFlows.length === 0 ? (
        <p className="text-xs text-muted-foreground">尚無主題資料</p>
      ) : (
        <div className="space-y-5">
          {/* RRG Scatter */}
          <RRGScatterChart flows={allFlows} />
          {/* T2 Filter Log */}
          <QuadrantFilterLog />
        </div>
      )}
    </div>
  )
}
