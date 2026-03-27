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
function RecommendationCard({ rec, rank }: { rec: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  const sig = SIGNAL_CONFIG[rec.signal] ?? SIGNAL_CONFIG['HOLD']
  const SigIcon = sig.icon

  const chip5dBillion = ((rec.foreign_net_5d ?? 0) + (rec.trust_net_5d ?? 0)).toFixed(2)
  const chipPositive  = parseFloat(chip5dBillion) > 0

  return (
    <div className={cn(
      'rounded-xl border transition-all',
      rank === 1
        ? 'border-amber-400/60 bg-amber-50/30 dark:bg-amber-950/10 shadow-sm'
        : 'border-border/50 bg-card hover:border-border',
    )}>
      {/* ── Header ── */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer select-none"
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
              法人 {chipPositive ? '+' : ''}{chip5dBillion}億
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
function SectorFlowBar({ flow, maxAbs }: { flow: any; maxAbs: number }) {
  const net = flow.total_net ?? 0
  const pct = maxAbs > 0 ? Math.abs(net) / maxAbs * 100 : 0
  const positive = net >= 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 truncate text-muted-foreground shrink-0" title={flow.sector}>{flow.sector}</span>
      <div className="flex-1 flex items-center gap-1">
        {!positive && (
          <div className="bg-red-400/70 h-3 rounded-sm ml-auto" style={{ width: `${pct}%` }} />
        )}
        <div className={cn('w-px h-4 bg-border shrink-0')} />
        {positive && (
          <div className="bg-green-500/80 h-3 rounded-sm" style={{ width: `${pct}%` }} />
        )}
      </div>
      <span className={cn('w-16 text-right font-mono', positive ? 'text-green-600' : 'text-red-500')}>
        {positive ? '+' : ''}{net.toFixed(1)}億
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

  const { data: industryData, isLoading: industryLoading } = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'industry', today],
    queryFn:  () => recommendationsApi.sectorFlow(undefined, 'industry'),
    staleTime: 30 * 60 * 1000,
  })
  const { data: themeData, isLoading: themeLoading } = useQuery({
    queryKey: ['recommendations', 'sector-flow', 'theme', today],
    queryFn:  () => recommendationsApi.sectorFlow(undefined, 'theme'),
    staleTime: 30 * 60 * 1000,
  })

  const recs  = recData?.recommendations  ?? []
  const industryFlows = industryData?.flows ?? []
  const themeFlows    = themeData?.flows    ?? []
  const industryMax = industryFlows.length ? Math.max(...industryFlows.map((f: any) => Math.abs(f.total_net ?? 0)), 1) : 1
  const themeMax    = themeFlows.length    ? Math.max(...themeFlows.map((f: any) => Math.abs(f.total_net ?? 0)), 1) : 1

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

      {/* ── Industry flow ── */}
      <div>
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-muted-foreground" />
          產業輪動（外資+投信5日合計）
        </h3>
        {industryLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-5 rounded bg-muted/40 animate-pulse" />)}
          </div>
        ) : industryFlows.length === 0 ? (
          <p className="text-xs text-muted-foreground">尚無產業資料</p>
        ) : (
          <div className="space-y-2">
            {industryFlows.slice(0, 10).map((f: any) => (
              <SectorFlowBar key={f.sector} flow={f} maxAbs={industryMax} />
            ))}
          </div>
        )}
      </div>

      {/* ── Theme flow ── */}
      <div>
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-blue-400" />
          主題輪動（概念股資金流向）
        </h3>
        {themeLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-5 rounded bg-muted/40 animate-pulse" />)}
          </div>
        ) : themeFlows.length === 0 ? (
          <p className="text-xs text-muted-foreground">尚無主題資料</p>
        ) : (
          <div className="space-y-2">
            {themeFlows.slice(0, 10).map((f: any) => (
              <SectorFlowBar key={f.sector} flow={f} maxAbs={themeMax} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
