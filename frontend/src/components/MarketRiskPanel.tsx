import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, BarChart3, Globe2, LineChart, ShieldCheck, TrendingDown, Waves } from 'lucide-react'
import { marketApi } from '@/lib/api'
import { formatTwDateTimeShort } from '@/lib/twTime'

type FactorStatus = 'ok' | 'info' | 'warn' | 'error' | 'missing'

interface MarketRiskFactor {
  id: string
  label: string
  value: string
  score?: number
  weight?: number
  contribution?: number
  status: FactorStatus
  source: string
  source_date?: string | null
  detail?: string
  missing_reason?: string
}

interface MarketRisk {
  date: string
  twiiClose: number | null
  twiiVol20: number | null
  twiiMa20: number | null
  twiiBias: number | null
  foreignConsecutiveSell: number
  foreignNet5d: number | null
  marginRatio: number | null
  riskScore: number
  riskLevel: 'green' | 'yellow' | 'orange' | 'red' | 'black'
  riskSummary: string
  calculatedAt: string
  contextFactors?: MarketRiskFactor[]
  factorPacket?: {
    schema_version: string
    score: number
    level: MarketRisk['riskLevel']
    generated_at: string
    missing_reasons?: Record<string, string>
  } | null
  regimeState?: {
    label: string
    family: string
    runDate: string | null
    computedAt: string
    source: string
  } | null
}

interface HistoryRow {
  date: string
  risk_score: number
  risk_level: string
}

const LEVEL_CONFIG = {
  green: { label: '低風險', color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', bar: 'bg-emerald-400' },
  yellow: { label: '留意', color: 'text-yellow-300', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', bar: 'bg-yellow-400' },
  orange: { label: '偏高', color: 'text-orange-300', bg: 'bg-orange-500/10', border: 'border-orange-500/30', bar: 'bg-orange-400' },
  red: { label: '高風險', color: 'text-red-300', bg: 'bg-red-500/10', border: 'border-red-500/30', bar: 'bg-red-400' },
  black: { label: '極端風險', color: 'text-zinc-200', bg: 'bg-zinc-700/50', border: 'border-zinc-400/40', bar: 'bg-zinc-300' },
}

const FACTOR_ICONS: Record<string, typeof Activity> = {
  price_trend: LineChart,
  volatility: Waves,
  breadth: BarChart3,
  chips: TrendingDown,
  leverage: Activity,
  regime: ShieldCheck,
  global_risk: Globe2,
  global: Globe2,
  lppls: AlertTriangle,
  hawkes: Activity,
  event_monitors: AlertTriangle,
}

const STATUS_STYLE: Record<FactorStatus, string> = {
  ok: 'border-emerald-400/25 bg-emerald-400/8 text-emerald-200',
  info: 'border-sky-400/20 bg-sky-400/8 text-sky-200',
  warn: 'border-amber-400/25 bg-amber-400/8 text-amber-200',
  error: 'border-red-400/25 bg-red-400/8 text-red-200',
  missing: 'border-slate-400/20 bg-slate-400/8 text-slate-300',
}

function fmtNumber(value: unknown, decimals = 1): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(decimals) : '0.0'
}

function fallbackFactors(risk: MarketRisk): MarketRiskFactor[] {
  return [
    { id: 'price_trend', label: '價格趨勢', value: `${Number(risk.twiiBias ?? 0).toFixed(2)}%`, status: Number(risk.twiiBias ?? 0) < -1 ? 'warn' : 'ok', source: 'market_risk.twii_bias' },
    { id: 'volatility', label: '波動', value: `${Number(risk.twiiVol20 ?? 0).toFixed(2)}%`, status: 'info', source: 'market_risk.twii_vol20' },
    { id: 'chips', label: '籌碼', value: `${Number(risk.foreignNet5d ?? 0).toFixed(1)}億`, status: Number(risk.foreignNet5d ?? 0) < 0 ? 'warn' : 'ok', source: 'market_risk.foreign_net_5d' },
    { id: 'leverage', label: '槓桿', value: risk.marginRatio == null ? 'n/a' : `${Number(risk.marginRatio).toFixed(2)}%`, status: 'info', source: 'market_risk.margin_ratio' },
    { id: 'regime', label: 'Regime', value: risk.regimeState?.label ?? 'missing', status: risk.regimeState ? 'ok' : 'error', source: risk.regimeState?.source ?? 'market_regime_state' },
  ]
}

export default function MarketRiskPanel() {
  const [risk, setRisk] = useState<MarketRisk | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [riskData, histData] = await Promise.all([
          marketApi.risk(),
          marketApi.riskHistory(30),
        ])
        setRisk(riskData)
        setHistory(histData)
      } catch (e: any) {
        setError(e.message ?? 'load_failed')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) {
    return (
      <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
        <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        載入大盤風險...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-5 text-sm">
        <p className="font-semibold text-amber-200">大盤風險 API 載入失敗</p>
        <p className="mt-1 text-xs text-muted-foreground">請回 OBS/Data Quality 查看 market_risk 與 market_regime_state。</p>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">source=market/risk status=degraded</p>
      </div>
    )
  }

  if (!risk) return null

  const cfg = LEVEL_CONFIG[risk.riskLevel] ?? LEVEL_CONFIG.green
  const factors = (risk.contextFactors?.length ? risk.contextFactors : fallbackFactors(risk)).slice(0, 9)
  const packetGeneratedAt = risk.factorPacket?.generated_at ?? risk.calculatedAt

  return (
    <div className="space-y-3">
      <div className={`rounded-lg border ${cfg.border} ${cfg.bg} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs text-muted-foreground">今日市場判讀</div>
            <div className={`mt-1 text-2xl font-bold ${cfg.color}`}>{cfg.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              regime={risk.regimeState?.label ?? 'missing'} · run_date={risk.regimeState?.runDate ?? risk.date}
            </div>
            <div className="mt-2 text-[11px] font-mono text-muted-foreground">
              policy={risk.factorPacket?.schema_version ?? 'legacy-market-risk'} · generated={formatTwDateTimeShort(packetGeneratedAt)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">風險分數</div>
            <div className={`mt-1 text-3xl font-bold tabular-nums ${cfg.color}`}>
              {risk.riskScore}<span className="text-sm font-normal text-muted-foreground">/100</span>
            </div>
          </div>
        </div>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted/30">
          <div className={`h-full rounded-full transition-all duration-700 ${cfg.bar}`} style={{ width: `${Math.max(0, Math.min(100, risk.riskScore))}%` }} />
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {factors.map((factor) => {
            const Icon = FACTOR_ICONS[factor.id] ?? Activity
            const scoreWidth = Math.max(4, Math.min(100, Number(factor.score ?? 0)))
            return (
              <div key={`${factor.id}:${factor.source}`} className={`rounded-md border p-3 ${STATUS_STYLE[factor.status] ?? STATUS_STYLE.info}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate text-xs font-semibold">{factor.label}</span>
                  </div>
                  <span className="shrink-0 font-mono text-xs">{factor.value}</span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/20">
                  <div className="h-full rounded-full bg-current opacity-80" style={{ width: `${scoreWidth}%` }} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                  <span className="truncate">{factor.source}</span>
                  <span className="shrink-0">w{Math.round(Number(factor.weight ?? 0) * 100)} / c{fmtNumber(factor.contribution, 1)}</span>
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  {factor.missing_reason ? `missing=${factor.missing_reason}` : factor.detail ?? ''}
                </div>
                {factor.source_date ? <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">source_date={factor.source_date}</div> : null}
              </div>
            )
          })}
        </div>

        <p className="mt-4 text-sm leading-relaxed text-foreground/80">{risk.riskSummary}</p>
        <div className="mt-3 text-xs text-muted-foreground">
          更新時間：{formatTwDateTimeShort(risk.calculatedAt)}
        </div>
      </div>

      {history.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">30 日風險分布</div>
            <div className="font-mono text-[10px] text-muted-foreground">{history[0]?.date.slice(5)} → {history[history.length - 1]?.date.slice(5)}</div>
          </div>
          <div className="flex h-16 items-end gap-0.5">
            {history.slice(-30).map((row) => {
              const h = Math.max(4, (row.risk_score / 100) * 64)
              const barCfg = LEVEL_CONFIG[row.risk_level as keyof typeof LEVEL_CONFIG] ?? LEVEL_CONFIG.green
              return (
                <div key={row.date} className="flex-1 rounded-sm transition-all" style={{ height: `${h}px` }} title={`${row.date} risk:${row.risk_score}`}>
                  <div className={`h-full w-full rounded-sm ${barCfg.bar} opacity-80`} />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
