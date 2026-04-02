/**
 * DailyRecommendationPanel.tsx
 * 每日選股推薦面板 — 顯示 ML + 籌碼 + LLM 綜合推薦結果
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { recommendationsApi } from '@/lib/api'
import {
  TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp,
  Zap, BarChart3, Users, AlertCircle, RefreshCw, Star,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Treemap, ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } from 'recharts'
import { paperApi } from '@/lib/api'

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

// ─── Signal badge config ───────────────────────────────────────────────────
const SIGNAL_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  STRONG_BUY: { label: '強烈買進', color: 'bg-red-500 text-white',     icon: Zap },
  BUY:        { label: '買進',     color: 'bg-green-500 text-white',   icon: TrendingUp },
  HOLD:       { label: '觀望',     color: 'bg-yellow-500 text-white',  icon: Minus },
  SELL:       { label: '賣出',     color: 'bg-blue-500 text-white',    icon: TrendingDown },
  STRONG_SELL:{ label: '強烈賣出', color: 'bg-purple-600 text-white',  icon: TrendingDown },
}

// ─── Score bar ─────────────────────────────────────────────────────────────
function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.round((value / max) * 100)
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-muted-foreground">{value}/{max}</span>
    </div>
  )
}

// ─── Single recommendation card ────────────────────────────────────────────
export function RecommendationCard({ rec, rank }: { rec: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  const sig = SIGNAL_CONFIG[rec.signal] ?? SIGNAL_CONFIG['HOLD']
  const SigIcon = sig.icon

  const chip5dRaw = (rec.foreign_net_5d ?? 0) + (rec.trust_net_5d ?? 0)
  const chipPositive  = chip5dRaw > 0

  return (
    <div className={cn(
      'rounded-xl border transition-all',
      rank === 1
        ? 'border-amber-500/40 bg-amber-500/[0.06] shadow-sm'
        : 'border-border/50 bg-card hover:border-border',
    )}>
      {/* ── Header ── */}
      <div
        className="flex items-center gap-3 p-3 sm:p-4 cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        {/* Rank badge */}
        <div className={cn(
          'w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0',
          rank === 1 ? 'bg-amber-400 text-white' :
          rank === 2 ? 'bg-gray-400 text-white' :
          rank === 3 ? 'bg-orange-400 text-white' :
          'bg-muted text-muted-foreground',
        )}>
          {rank}
        </div>

        {/* Stock info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{rec.symbol}</span>
            <span className="text-sm text-muted-foreground truncate">{rec.name}</span>
            {rec.sector && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{rec.sector}</Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {/* Signal */}
            <Badge className={cn('text-[10px] px-1.5 py-0', sig.color)}>
              <SigIcon className="w-2.5 h-2.5 mr-1" />
              {sig.label}
            </Badge>
            {/* Chip flow */}
            <span className={cn('text-xs flex items-center gap-1', chipPositive ? 'text-green-600' : 'text-red-500')}>
              <Users className="w-3 h-3" />
              法人 {fmtChipAmount(chip5dRaw)}
            </span>
            {/* RSI */}
            {rec.rsi14 != null && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <BarChart3 className="w-3 h-3" />
                RSI {rec.rsi14.toFixed(1)}
              </span>
            )}
          </div>
        </div>

        {/* Score */}
        <div className="text-right shrink-0">
          <div className="text-lg font-bold text-primary">{Math.round(rec.score)}</div>
          <div className="text-[10px] text-muted-foreground">分</div>
        </div>

        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> :
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-border/40 pt-3 space-y-4">
          {/* Score breakdown */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground mb-2">評分明細</p>
            <ScoreBar label="籌碼" value={rec.chip_score  ?? 0} max={40} color="bg-blue-500" />
            <ScoreBar label="技術" value={rec.tech_score  ?? 0} max={30} color="bg-purple-500" />
            <ScoreBar label="ML"   value={rec.ml_score    ?? 0} max={30} color="bg-emerald-500" />
          </div>

          {/* Reason */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">推薦理由</p>
            <p className="text-sm leading-relaxed text-foreground/90">{rec.reason}</p>
          </div>

          {/* Watch points */}
          {rec.watch_points?.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                需注意
              </p>
              <ul className="space-y-1">
                {rec.watch_points.map((pt: string, i: number) => (
                  <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                    <span className="text-amber-500 shrink-0 mt-0.5">▸</span>
                    {pt}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ML confidence */}
          {rec.confidence != null && (
            <p className="text-[11px] text-muted-foreground">
              ML 模型信心度：{(rec.confidence * 100).toFixed(0)}%
              {rec.current_price != null && (
                <span className="ml-3">現價：{rec.current_price.toFixed(2)}</span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
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
        {/* 左半：賣超（紅色，從中間向左長） */}
        <div className="w-1/2 flex justify-end">
          {!positive && (
            <div className="bg-red-400/70 h-3 rounded-sm" style={{ width: `${pct}%` }} />
          )}
        </div>
        {/* 中線 */}
        <div className="w-px h-4 bg-border shrink-0" />
        {/* 右半：買超（綠色，從中間向右長） */}
        <div className="w-1/2">
          {positive && (
            <div className="bg-emerald-500/80 h-3 rounded-sm" style={{ width: `${pct}%` }} />
          )}
        </div>
      </div>
      <span className={cn('w-16 text-right font-mono', positive ? 'text-emerald-400' : 'text-red-400')}>
        {fmtChipAmount(net)}
      </span>
    </div>
  )
}

// ─── Main panel ────────────────────────────────────────────────────────────
export function DailyRecommendationPanel() {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date

  const { data: recData, isLoading: recLoading, refetch } = useQuery({
    queryKey: ['recommendations', 'daily', today],
    queryFn:  () => recommendationsApi.daily(),
    staleTime: 30 * 60 * 1000,
  })

  const recs  = recData?.recommendations  ?? []

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Star className="w-4 h-4 text-amber-400" />
            每日選股推薦
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {recData?.date ?? today} · ML + 籌碼 + LLM 綜合評分
          </p>
        </div>
        <Button
          variant="ghost" size="sm"
          onClick={() => refetch()}
          className="text-xs gap-1.5"
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
        <div className="space-y-3">
          {recs.map((rec: any, i: number) => (
            <RecommendationCard key={rec.stock_id ?? i} rec={rec} rank={i + 1} />
          ))}
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
                item.positive ? 'text-cyan-400' : 'text-red-400',
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

// Bot Dashboard 用 — 含象限 + RS（差異化）
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
            <tr className="text-muted-foreground border-b border-white/[0.06]">
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
                <tr key={f.sector} className="border-b border-white/[0.03]">
                  <td className="py-1 pl-1 truncate max-w-[6rem]" title={f.sector}>{f.sector}</td>
                  <td className="py-1 px-1">
                    <div className="flex items-center h-3">
                      <div className="w-1/2 flex justify-end">
                        {net < 0 && <div className="bg-red-400/70 h-2.5 rounded-sm" style={{ width: `${Math.min(100, Math.abs(net) / maxAbs * 100)}%` }} />}
                      </div>
                      <div className="w-px h-3 bg-zinc-700 shrink-0" />
                      <div className="w-1/2">
                        {net >= 0 && <div className="bg-emerald-500/70 h-2.5 rounded-sm" style={{ width: `${Math.min(100, Math.abs(net) / maxAbs * 100)}%` }} />}
                      </div>
                    </div>
                    <div className={cn('text-[10px] font-mono text-center', net >= 0 ? 'text-emerald-400' : 'text-red-400')}>
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

// ─── Theme Flow Panel（Dashboard 用）— Ranking Table + Treemap ───────────────
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
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-sm p-4">
      <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-blue-400" />
        主題輪動（三大法人近5日買賣超）
      </h3>
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
            <p className="text-xs text-emerald-400 font-medium mb-2">買超前 10 大</p>
            <div className="space-y-1.5">
              {topBuy.length ? topBuy.map((f: any) => (
                <SectorFlowBar key={f.sector} flow={f} maxAbs={maxAbs} />
              )) : <p className="text-xs text-muted-foreground">無買超主題</p>}
            </div>
          </div>
          {/* Bar chart — 賣超 */}
          <div>
            <p className="text-xs text-red-400 font-medium mb-2">賣超前 10 大</p>
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
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 10, bottom: 20, left: 10 }}>
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
                  <div className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs">
                    <p className="font-medium">{d.name}</p>
                    <p className="text-muted-foreground">RS: {d.x?.toFixed(1)} | Mom: {d.y?.toFixed(1)}</p>
                    <p style={{ color: QUADRANT_COLORS[d.quadrant] }}>{d.quadrant}</p>
                  </div>
                )
              }}
            />
            <Scatter data={data}>
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
              <span className={cn('text-[10px]', entry.momentum_dir === 'up' ? 'text-emerald-400' : 'text-red-400')}>
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
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-sm p-4">
      <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-blue-400" />
        主題輪動 + RRG 四象限
      </h3>
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
          {/* Bot Ranking Tables — 含象限 + RS 差異化 */}
          <BotThemeRankingTable flows={topBuy} title="買超前 10 大" color="text-emerald-400" />
          <BotThemeRankingTable flows={topSell} title="賣超前 10 大" color="text-red-400" />
        </div>
      )}
    </div>
  )
}
