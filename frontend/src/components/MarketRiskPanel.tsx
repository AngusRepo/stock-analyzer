import { useEffect, useState } from 'react'
import { marketApi } from '@/lib/api'

interface MarketRisk {
  date: string
  vix: number | null
  vixLevel: string
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
}

interface HistoryRow {
  date: string
  risk_score: number
  risk_level: string
}

const LEVEL_CONFIG = {
  green:  { label: '低風險', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', bar: 'bg-emerald-500' },
  yellow: { label: '偏保守', color: 'text-yellow-400',  bg: 'bg-yellow-500/10',  border: 'border-yellow-500/30',  bar: 'bg-yellow-500' },
  orange: { label: '高波動', color: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30',  bar: 'bg-orange-500' },
  red:    { label: '高風險', color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     bar: 'bg-red-500' },
  black:  { label: '停手機制', color: 'text-zinc-300',  bg: 'bg-zinc-800/80',    border: 'border-zinc-500/50',    bar: 'bg-zinc-400' },
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
        載入市場風險中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-5 text-sm">
        <p className="font-semibold text-amber-200">市場風險 API 載入失敗</p>
        <p className="mt-1 text-xs text-muted-foreground">風險資訊暫時降級，請以 OBS/Data Quality 追來源。</p>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">source=market/risk status=degraded</p>
      </div>
    )
  }

  if (!risk) return null

  const cfg = LEVEL_CONFIG[risk.riskLevel] ?? LEVEL_CONFIG.green

  return (
    <div className="space-y-3">
      <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-5`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs text-muted-foreground">大盤風險等級</div>
            <div className={`mt-1 text-2xl font-bold ${cfg.color}`}>{cfg.label}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">風險分數</div>
            <div className={`mt-1 text-3xl font-bold tabular-nums ${cfg.color}`}>
              {risk.riskScore}<span className="text-sm font-normal text-muted-foreground">/100</span>
            </div>
          </div>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted/30">
          <div className={`h-full rounded-full transition-all duration-700 ${cfg.bar}`} style={{ width: `${risk.riskScore}%` }} />
        </div>
        <p className="mt-4 text-sm leading-relaxed text-foreground/80">{risk.riskSummary}</p>
        <div className="mt-3 text-xs text-muted-foreground">
          更新時間：{new Date(risk.calculatedAt).toLocaleString('zh-TW')}
        </div>
      </div>

      {history.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            近 30 日風險趨勢
          </div>
          <div className="flex h-16 items-end gap-0.5">
            {history.slice(-30).map((row) => {
              const h = Math.max(4, (row.risk_score / 100) * 64)
              const barCfg = LEVEL_CONFIG[row.risk_level as keyof typeof LEVEL_CONFIG] ?? LEVEL_CONFIG.green
              return (
                <div key={row.date} className="flex-1 rounded-sm transition-all" style={{ height: `${h}px` }} title={`${row.date} 風險:${row.risk_score}`}>
                  <div className={`h-full w-full rounded-sm ${barCfg.bar} opacity-80`} />
                </div>
              )
            })}
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>{history[0]?.date.slice(5)}</span>
            <span>今天</span>
          </div>
        </div>
      )}
    </div>
  )
}
