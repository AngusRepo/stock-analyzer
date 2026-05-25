/**
 * StockAIReport — AI 個股分析報告（嵌入 Dashboard AI tab）
 * 自動 fetch ML 預測 + AI Summary + LLM 摘要/技術/交易
 * 不需要登入也能看 Summary/ML，LLM 部分需 auth
 */
import { useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { stocksApi, mlApi, llmApi } from '@/lib/api'
import { useAuth } from '@/_core/hooks/useAuth'
import { buildScoreBreakdownViewModel } from '@/lib/scoreV2ViewModel'
import {
  TrendingUp, TrendingDown, Brain, BarChart2,
  Shield, Zap, RefreshCw, Tag, Building2, DollarSign,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const SIGNAL_CFG: Record<string, { label: string; accent: string; bg: string; border: string }> = {
  STRONG_BUY:  { label: '強力買進', accent: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30' },
  BUY:         { label: '買進',     accent: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30' },
  HOLD:        { label: '持有觀望', accent: 'text-yellow-400',  bg: 'bg-yellow-500/10',  border: 'border-yellow-500/30' },
  SELL:        { label: '賣出',     accent: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
  STRONG_SELL: { label: '強力賣出', accent: 'text-emerald-300', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30' },
  NO_SIGNAL:   { label: '訊號不明', accent: 'text-muted-foreground', bg: 'bg-muted/20', border: 'border-border' },
}
const MODEL_COLORS: Record<string, string> = {
  'KalmanFilter': '#3b82f6',
  'DLinear': '#8b5cf6',
  'MarkovSwitching': '#06b6d4',
  'PatchTST': '#f59e0b',
  'Chronos': '#ef4444',
  'XGBoost': '#10b981',
  'CatBoost': '#f97316',
  'ExtraTrees': '#ec4899',
  'LightGBM': '#14b8a6',
  'FT-Transformer': '#6366f1',
}

const STATE_SPACE_OVERLAYS = new Set(['KalmanFilter', 'MarkovSwitching'])

function modelDisplayName(name: string): string {
  return STATE_SPACE_OVERLAYS.has(name) ? `${name} overlay` : name
}

function Section({ title, icon: Icon, children, className }: {
  title: string; icon?: any; children: React.ReactNode; className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-white/[0.08] bg-white/[0.03] p-4', className)}>
      <div className="flex items-center gap-2 mb-3">
        {Icon && <Icon className="w-4 h-4 text-primary" />}
        <h3 className="text-sm font-bold">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="min-w-16 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 text-right font-mono text-muted-foreground">{value}/{max}</span>
    </div>
  )
}

function LLMSection({ title, icon: Icon, data, isPending, field }: {
  title: string; icon: any; data: any; isPending: boolean; field: string
}) {
  const text = data?.[field] ?? data?.result ?? (typeof data === 'string' ? data : null)
  return (
    <Section title={title} icon={Icon}>
      {isPending ? (
        <div className="flex items-center gap-2 py-3">
          <RefreshCw className="w-4 h-4 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground animate-pulse">AI 分析中…</span>
        </div>
      ) : text ? (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/85">{text}</div>
      ) : (
        <p className="text-xs text-muted-foreground/50 py-2">分析產生中或無資料</p>
      )}
    </Section>
  )
}

export default function StockAIReport({ stockId }: { stockId: number }) {
  const { isAuthenticated } = useAuth()

  // AI Summary
  const { data: aiData, isLoading: aiLoading } = useQuery({
    queryKey: ['stocks', 'ai-summary', stockId],
    queryFn: () => stocksApi.aiSummary(stockId),
    enabled: !!stockId,
    staleTime: 5 * 60_000,
  })

  // ML 預測
  const { data: mlData, isLoading: mlLoading } = useQuery({
    queryKey: ['ml', 'predict', stockId],
    queryFn: () => mlApi.getPredict(stockId),
    enabled: !!stockId,
    retry: false,
  })

  // LLM: 自動觸發（需登入）
  const summaryMut = useMutation({ mutationFn: () => llmApi.analystSummary(stockId) })
  const techMut = useMutation({ mutationFn: () => llmApi.technicalAnalysis(stockId) })
  const tradeMut = useMutation({ mutationFn: () => llmApi.tradingAdvice(stockId) })

  useEffect(() => {
    if (!stockId || !isAuthenticated) return
    summaryMut.mutate()
    techMut.mutate()
    tradeMut.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockId, isAuthenticated])

  const rec = aiData?.recommendation
  const tags = aiData?.tags ?? []
  const chip = aiData?.chip5d
  const fin = aiData?.financials
  const profile = aiData?.profile
  const ml = mlData as any
  const signalKey = ml?.signal ?? rec?.signal ?? 'NO_SIGNAL'
  const cfg = SIGNAL_CFG[signalKey] ?? SIGNAL_CFG.NO_SIGNAL
  const scoreViewModel = rec ? buildScoreBreakdownViewModel(rec) : null

  if (aiLoading || mlLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3">
        <RefreshCw className="w-5 h-5 animate-spin text-primary" />
        <span className="text-muted-foreground">載入 AI 分析…</span>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ═══ 信號總覽 ═══ */}
      <Section title="投資信號總覽" icon={Zap}>
        <div className={cn('rounded-xl border-2 p-4 mb-3', cfg.bg, cfg.border)}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground mb-1">綜合信號</p>
              <p className={cn('text-2xl font-bold', cfg.accent)}>{cfg.label}</p>
              <div className="flex flex-wrap gap-3 mt-2 text-sm">
                {rec && (
                  <>
                    <span className="text-muted-foreground">評分 <span className="text-foreground font-bold">{Math.round(scoreViewModel?.finalScore ?? 0)}</span></span>
                    <span className="text-muted-foreground">信心 <span className="text-foreground font-bold">{((rec.confidence ?? 0) * 100).toFixed(0)}%</span></span>
                  </>
                )}
                {ml?.consensus != null && (
                  <span className="text-muted-foreground">ML 共識 <span className="text-foreground font-bold">{((ml.consensus) * 100).toFixed(0)}%</span></span>
                )}
                {ml?.forecast_pct != null && (
                  <span className="text-muted-foreground">
                    5日預測 <span className={cn('font-bold', ml.forecast_pct >= 0 ? 'text-red-400' : 'text-emerald-400')}>
                      {(ml.forecast_pct * 100).toFixed(1)}%
                    </span>
                  </span>
                )}
              </div>
            </div>
            {signalKey !== 'NO_SIGNAL' && (
              <div className="shrink-0">
                {signalKey.includes('BUY') ? <TrendingUp className={cn('w-8 h-8', cfg.accent)} /> :
                 signalKey.includes('SELL') ? <TrendingDown className={cn('w-8 h-8', cfg.accent)} /> :
                 <BarChart2 className={cn('w-8 h-8', cfg.accent)} />}
              </div>
            )}
          </div>
          {rec?.reason && (
            <p className="mt-3 text-xs text-muted-foreground/80 leading-relaxed border-t border-white/[0.06] pt-2">{rec.reason}</p>
          )}
        </div>

        {/* 評分拆解 */}
        {scoreViewModel && scoreViewModel.rows.length > 0 && (
          <div className="space-y-2">
            {scoreViewModel?.rows.map((item) => (
              <ScoreBar key={item.key} label={item.label} value={item.value} max={item.max} color={item.color} />
            ))}
          </div>
        )}

        {/* 進場/停損/目標 */}
        {ml && signalKey !== 'NO_SIGNAL' && (
          <div className="grid grid-cols-4 gap-2 mt-3">
            {[
              { label: '進場參考', value: ml.entry_price, cls: 'text-foreground' },
              { label: '停損',     value: ml.stop_loss,   cls: 'text-emerald-400' },
              { label: '目標 1',   value: ml.target1,     cls: 'text-red-400' },
              { label: '目標 2',   value: ml.target2,     cls: 'text-red-300' },
            ].map(item => (
              <div key={item.label} className="rounded-lg border border-white/[0.08] bg-muted/20 p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground mb-1">{item.label}</p>
                <p className={cn('text-sm font-bold font-mono', item.cls)}>
                  {typeof item.value === 'number' ? `$${item.value.toFixed(2)}` : '—'}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ═══ 模型投票 ═══ */}
      {ml?.models?.length > 0 && (
        <Section title="ML 模型投票明細" icon={Brain}>
          <div className="space-y-2.5">
            {ml.models.map((m: any) => (
              <div key={m.name} className="flex items-center gap-2 text-xs">
                <span className="w-20 text-[10px] font-medium px-2 py-0.5 rounded-full text-black text-center shrink-0"
                  style={{ backgroundColor: MODEL_COLORS[m.name] ?? '#888' }}>
                  {modelDisplayName(m.name)}
                </span>
                <span className={cn('w-8 text-center', m.direction === 'up' ? 'text-red-400' : 'text-emerald-400')}>
                  {m.direction === 'up' ? '↑ 漲' : '↓ 跌'}
                </span>
                <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${(m.confidence * 100).toFixed(0)}%`, backgroundColor: MODEL_COLORS[m.name] ?? '#888' }} />
                </div>
                <span className="text-muted-foreground w-10 text-right font-mono">{(m.confidence * 100).toFixed(0)}%</span>
                <span className="text-muted-foreground/60 w-16 text-right">準確 {(m.direction_accuracy * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
          {ml.reasoning && (
            <p className="mt-3 text-xs text-muted-foreground/70 leading-relaxed border-t border-white/[0.06] pt-2">{ml.reasoning}</p>
          )}
        </Section>
      )}

      {/* ═══ 概念標籤 + 法人 + 基本面 ═══ */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Section title="概念標籤" icon={Tag}>
          {tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t: any) => (
                <span key={t.tag} className="text-xs px-2 py-1 rounded-lg bg-primary/10 text-primary/80 border border-primary/20">
                  {t.tag}{t.weight < 1 && <span className="text-muted-foreground/50 ml-1">{t.weight.toFixed(1)}</span>}
                </span>
              ))}
            </div>
          ) : <p className="text-xs text-muted-foreground/50">尚未分類</p>}
          {profile?.business_desc && (
            <p className="mt-2 text-[11px] text-muted-foreground/60 leading-relaxed line-clamp-3 border-t border-white/[0.05] pt-2">
              {profile.business_desc.replace(/\*\*/g, '').slice(0, 200)}
            </p>
          )}
        </Section>

        <Section title="法人近 5 日" icon={Building2}>
          {chip ? (
            <div className="space-y-2">
              {[{ label: '外資', value: chip.foreign_net }, { label: '投信', value: chip.trust_net }].map(row => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{row.label}</span>
                  <span className={cn('text-sm font-bold font-mono', (row.value ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {row.value != null ? `${row.value >= 0 ? '+' : ''}${(row.value / 1000).toFixed(0)}張` : '-'}
                  </span>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-muted-foreground/50">無資料</p>}
        </Section>

        <Section title="基本面" icon={DollarSign}>
          {fin ? (
            <div className="space-y-2">
              {[
                { label: 'P/E', value: fin.pe != null ? Number(fin.pe).toFixed(1) : '-' },
                { label: 'ROE', value: fin.roe != null ? `${Number(fin.roe).toFixed(1)}%` : '-' },
                { label: 'EPS', value: fin.eps != null ? Number(fin.eps).toFixed(2) : '-' },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{row.label}</span>
                  <span className="text-sm font-bold font-mono">{row.value}</span>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-muted-foreground/50">無資料</p>}
        </Section>
      </div>

      {/* ═══ LLM 分析（需登入）— 三欄並排 ═══ */}
      {isAuthenticated ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <LLMSection title="分析師摘要" icon={Brain} data={summaryMut.data} isPending={summaryMut.isPending} field="summary" />
          <LLMSection title="技術分析" icon={BarChart2} data={techMut.data} isPending={techMut.isPending} field="analysis" />
          <LLMSection title="交易建議" icon={Shield} data={tradeMut.data} isPending={tradeMut.isPending} field="advice" />
        </div>
      ) : (
        <Section title="AI 深度分析" icon={Brain}>
          <p className="text-xs text-muted-foreground text-center py-4">登入後自動產生分析師摘要、技術分析與交易建議</p>
        </Section>
      )}

      <p className="text-[10px] text-muted-foreground/40 text-center py-2">⚠ AI 分析僅供參考，不構成投資建議</p>
    </div>
  )
}
