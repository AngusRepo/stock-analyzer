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

const VIX_LABEL: Record<string, string> = {
  low: '偏低',
  normal: '正常',
  elevated: '升溫',
  high: '高檔',
  extreme: '極端',
}

function MetricTile({ label, value, detail, tone = 'text-[#d6e2ef]' }: {
  label: string
  value: string
  detail?: string
  tone?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${tone}`}>{value}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  )
}

function formatIndexValue(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : '--'
}

export default function MarketRiskPanel() {
  const [risk, setRisk] = useState<MarketRisk | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [indices, setIndices] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [riskData, histData, indexData] = await Promise.all([
          marketApi.risk(),
          marketApi.riskHistory(30),
          marketApi.indices(),
        ])
        setRisk(riskData)
        setHistory(histData)
        setIndices(Array.isArray(indexData)
          ? indexData
          : [indexData?.twii, indexData?.twoii, indexData?.nasdaq, indexData?.sp500].filter(Boolean))
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
  const twii = indices.find((idx) => String(idx.symbol ?? idx.name ?? '').toUpperCase().includes('TWII')) ?? indices[0]
  const otc = indices.find((idx) => {
    const key = String(idx.symbol ?? idx.name ?? '').toUpperCase()
    return key.includes('OTC') || key.includes('TWOII') || key.includes('櫃')
  }) ?? indices[1]

  const indexTile = (idx: any, fallbackLabel: string) => {
    const change = Number(idx?.change ?? idx?.change_value ?? 0)
    const changePct = Number(idx?.changePct ?? idx?.change_pct ?? 0)
    const current = idx?.current ?? idx?.close ?? idx?.price
    const up = change >= 0
    return {
      label: idx?.name ?? idx?.symbol ?? fallbackLabel,
      value: formatIndexValue(current),
      detail: `${up ? '+' : ''}${change.toFixed(2)} (${up ? '+' : ''}${changePct.toFixed(2)}%)`,
      tone: up ? 'text-red-400' : 'text-emerald-400',
    }
  }

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

      <div className="grid gap-3 lg:grid-cols-3">
        <MetricTile
          label="VIX 恐慌指數"
          value={risk.vix?.toFixed(1) ?? '--'}
          detail={`${VIX_LABEL[risk.vixLevel] ?? risk.vixLevel}，一般正常值約 < 20`}
          tone={
            risk.vixLevel === 'extreme' ? 'text-red-400'
              : risk.vixLevel === 'high' ? 'text-orange-400'
                : risk.vixLevel === 'elevated' ? 'text-yellow-400'
                  : 'text-emerald-400'
          }
        />
        <MetricTile {...indexTile(twii, '加權指數')} />
        <MetricTile {...indexTile(otc, '櫃買指數')} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <MetricTile
          label="台股 20 日波動率"
          value={risk.twiiVol20 != null ? `${risk.twiiVol20}%` : '--'}
          detail="年化波動率，正常參考約 < 18%"
        />
        <MetricTile
          label="大盤乖離率（20MA）"
          value={risk.twiiBias != null ? `${risk.twiiBias > 0 ? '+' : ''}${risk.twiiBias.toFixed(1)}%` : '--'}
          detail={`MA20：${risk.twiiMa20?.toLocaleString('zh-TW') ?? '--'}`}
          tone={
            risk.twiiBias == null ? 'text-[#d6e2ef]'
              : Math.abs(risk.twiiBias) >= 6 ? 'text-orange-400'
                : Math.abs(risk.twiiBias) >= 3 ? 'text-yellow-400'
                  : 'text-emerald-400'
          }
        />
        <MetricTile
          label="外資動向"
          value={
            risk.foreignConsecutiveSell < 0
              ? `連賣 ${Math.abs(risk.foreignConsecutiveSell)} 日`
              : risk.foreignConsecutiveSell > 0
                ? `連買 ${risk.foreignConsecutiveSell} 日`
                : '中性'
          }
          detail={risk.foreignNet5d != null ? `近 5 日：${risk.foreignNet5d > 0 ? '+' : ''}${risk.foreignNet5d.toFixed(0)} 億元` : '近 5 日：--'}
          tone={risk.foreignConsecutiveSell <= -3 ? 'text-red-400' : risk.foreignConsecutiveSell <= -1 ? 'text-orange-400' : 'text-emerald-400'}
        />
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

      {risk.marginRatio != null && (
        <MetricTile
          label="融資使用率"
          value={`${risk.marginRatio.toFixed(1)}%`}
          detail="高於 80% 視為槓桿偏熱"
          tone={risk.marginRatio >= 80 ? 'text-red-400' : risk.marginRatio >= 65 ? 'text-yellow-400' : 'text-emerald-400'}
        />
      )}
    </div>
  )
}
